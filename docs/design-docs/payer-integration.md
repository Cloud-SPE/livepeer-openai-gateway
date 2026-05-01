---
title: PayerDaemon integration (current shipped shell vs v3 target)
status: accepted
last-reviewed: 2026-05-01
---

# PayerDaemon integration

How this shell talks to the `payment-daemon` sidecar from
`livepeer-modules` to acquire signed payment blobs for WorkerNode
requests, and how that differs from the newer upstream v3 sender
contract.

## Scope note

This document describes two states:

- the **current shipped shell/runtime path** in this repo today, which
  still flows through `@cloudspe/livepeer-openai-gateway-core@3.0.0`
  and its session-oriented payer interface
- the **upstream v3 sender contract** already landed in
  `livepeer-modules-project`, where sender mode now exposes only
  `CreatePayment(face_value, recipient)` plus `GetDepositInfo`

The shell has not consumed that new contract yet because the pinned core
package in this repo still expects the older session bootstrap path.

## Topology

```
┌──────────────────────────────┐
│            bridge            │
│  service/payments  ──────────┼──── unix socket ──┐
│       │                      │                   │
│  providers/payerDaemon/grpc ─┤                   ▼
└──────────────────────────────┘           ┌──────────────┐
                                           │ PayerDaemon  │
                                           │ (sidecar,    │
                                           │  --mode=     │
                                           │  sender)     │
                                           └──────────────┘
```

- The daemon runs as a local sidecar; the bridge is a gRPC **client** only. The daemon exposes no callbacks and the bridge exposes no gRPC **server** for it — which is why there is no inbound gRPC interceptor in 0004.
- Transport: `unix:///var/run/livepeer-payment-daemon.sock` (overridable via `PAYER_DAEMON_SOCKET`).

## Proto source

- Proto lives in the sibling repo `../livepeer-modules/payment-daemon/proto/`.
- `npm run proto:gen` runs `buf generate` with `ts-proto`; output lives under `src/providers/payerDaemon/gen/` and is committed.
- Regenerate explicitly when the library's `livepeer.payments.v1` proto changes. The generated folder is excluded from coverage (`vitest.config.ts`).

## Current shipped shell interface

`src/providers/payerDaemon.ts` declares the bridge's domain-level client:

```ts
interface PayerDaemonClient {
  startSession(input, signal?): Promise<StartSessionOutput>;
  createPayment(input): Promise<CreatePaymentOutput>;
  closeSession(workId, signal?): Promise<void>;
  getDepositInfo(signal?): Promise<DepositInfo>;
  isHealthy(): boolean;
  startHealthLoop(): void;
  stopHealthLoop(): void;
  close(): Promise<void>;
}
```

All inputs and outputs use domain types (`bigint`, `0x`-prefixed hex strings). Protobuf wire types never leak past `providers/payerDaemon/`.

This is the compatibility surface the currently pinned engine package
still uses. It is not the v3 target interface.

### Current shipped session bootstrap requires `priceInfo`

`StartSessionInput` carries a REQUIRED `priceInfo` field in the
currently pinned runtime. That price came from the legacy worker quote
path and was threaded into `StartSessionRequest.price_info`; the sender
daemon then stamped it into `Payment.expected_price`. This is a
compatibility-path detail only and is not part of the suite v3.0.1
contract.

In practice, `service/payments/sessions.ts::createSessionCache.getOrStart`
reads `quote.priceInfo` and passes it on every `startSession` call.
Again, that is only the shell's pinned compatibility path.

This section remains relevant only for the shell's currently pinned
runtime path.

## Upstream v3 sender contract

Upstream `payment-daemon` sender mode now exposes this public gRPC
shape:

```proto
service PayerDaemon {
  rpc CreatePayment(CreatePaymentRequest) returns (CreatePaymentResponse);
  rpc GetDepositInfo(GetDepositInfoRequest) returns (GetDepositInfoResponse);
}

message CreatePaymentRequest {
  bytes face_value = 1;
  bytes recipient = 2;
}
```

Operationally, the upstream sender daemon now:

1. Accepts exact `face_value` plus `recipient`.
2. Relies on the gateway having already selected one route via
   `Resolver.Select(capability, offering, tier, min_weight)`.
3. Resolves the recipient worker URL through the local resolver and
   fetches canonical ticket params from the payee-side ticket-params
   endpoint.
4. Signs a one-ticket payment blob and returns it to the caller.

Under that v3 flow, the worker is price-blind. Wholesale price comes
from manifest/resolver selection, the gateway computes `face_value`, and
the worker only validates the attached payment and reports actual usage.

That means the old public `StartSession(...)` and `CloseSession(...)`
contract is no longer the target architecture for this shell. The
remaining work here is consuming the new daemon contract through a newer
`@cloudspe/livepeer-openai-gateway-core` release.

## Converters

`src/providers/payerDaemon/convert.ts`:

- `bigintToBigEndianBytes(v: bigint): Buffer` / `bigEndianBytesToBigint(buf): bigint` for wei-valued fields (`faceValue`, `expirationBlock`, `deposit`, `reserve`, `expectedValue`).
- `hexToBytes(0x…)` / `bytesToHex(buf)` for address and hash fields.
- `domainTicketParamsToWire` / `wireTicketParamsToDomain` — one translator per direction; covered by tests.

## Error mapping

`mapGrpcError` in `src/providers/payerDaemon/errors.ts`:

| gRPC status                                                          | Bridge error class                                                | HTTP outcome (v1)                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, socket-level errors, `null` code | `PayerDaemonUnavailableError` (code `payment_daemon_unavailable`) | 503 — fail-closed per core-belief #6 |
| `INVALID_ARGUMENT`, `FAILED_PRECONDITION`                            | `PayerDaemonProtocolError` (code `internal`)                      | 500 — our bug or proto drift         |
| `CANCELLED`                                                          | `PayerDaemonError` with `name = "PayerDaemonCancelledError"`      | Re-thrown; caller decides            |
| Anything else                                                        | `PayerDaemonError` preserving the gRPC code                       | 500, logged with code                |

## Health model

Background loop (scheduler-injected, same pattern as 0005 QuoteRefresher):

- Fires a `GetDepositInfo` call every `PAYER_DAEMON_HEALTH_INTERVAL_MS` (default 10 s) with the normal call deadline (default 5 s).
- On success, `consecutive_failures = 0` and `isHealthy() = true`.
- On failure, `consecutive_failures += 1`. Once it hits `PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD` (default 2), `isHealthy()` flips to false.
- On next success, `isHealthy()` flips back to true.

`service/payments.createPaymentForRequest` consults `isHealthy()` before every call; false short-circuits to `PayerDaemonNotHealthyError` without touching the network. The runtime layer maps that to 503.

## Current shipped session lifecycle

`src/service/payments/sessions.ts` amortizes sessions across requests. Cache key is `(nodeId, recipient, ticketParams.expirationBlock)` — distinct `expirationBlock` values mean the node's quote rotated, so the old session is no longer usable.

- First request for a key → `startSession(quote.ticketParams, priceInfo)` → cache `{ workId, expiresAt = quote.expiresAt }`.
- Subsequent requests within `expiresAt` → reuse the cached `workId`.
- Past `expiresAt` → drop the cached entry and open a fresh session.
- `close(nodeId)` drains all sessions for that node (used on node removal from NodeBook).
- `closeAll()` drains everything on bridge shutdown.

All `closeSession` calls are best-effort — failures are swallowed so a hung daemon doesn't block shutdown.

**Cache-key fragility (open).** The key is `(nodeId, recipient, expirationBlock)`. It does **not** include `recipientRandHash`. If the worker's daemon restarts (new in-memory HMAC secret → new `recipientRandHash`) but the bridge's cached `expirationBlock` happens to overlap (a freshly-quoted ticket from the new daemon lands in the same expiration window as the old cached entry), the bridge reuses a stale session whose `workId` references a `recipientRand` the daemon can no longer derive. ProcessPayment 402s with `invalid recipientRand for recipientRandHash`. This was investigated during the first mainnet smoke deploy and turned out **not** to be the bug we hit (the actual bug was the missing `priceInfo` in `StartSession`, fixed in `b5190a9` / `d76eb42`), but the cache shape is brittle. Tracked as `bridge-session-cache-misses-recipient-rand-hash` in the bridge tech-debt tracker. Receiver-side the right fix is to persist the secret (`receiver-secret-persistence` in the library tracker); bridge-side we should add `recipientRandHash` to the cache key as defense-in-depth.

## Call deadlines and AbortSignal

Every call synthesizes `AbortSignal.any([callerSignal, AbortSignal.timeout(callTimeoutMs)])`. The caller's signal propagates cancellation; the timeout prevents a hung unix-socket call from stalling the request indefinitely. `PAYER_DAEMON_CALL_TIMEOUT_MS` is 5 s by default — overridable via env, and per-call overrides are possible by passing a pre-composed signal.

## Restart semantics

No state is persisted across bridge restarts. Fresh process = fresh
session namespace. The daemon survives naturally — its BoltDB/SQLite
store holds balances, winning tickets, and the escrow watcher state. A
restarted bridge reopens sessions via `startSession` on the next
customer request while this repo remains on the older engine/runtime
path.

## What this doc does NOT cover

- How `service/payments.createPaymentForRequest` is stitched into the customer request flow. That's 0007 (non-streaming) and 0008 (streaming).
- The daemon's own lifecycle (binary deployment, keystore passphrase, escrow funding). See `livepeer-modules/payment-daemon/docs/`.
- Reconciliation between CustomerLedger USD, PayerDaemon off-chain EV, and TicketBroker on-chain ETH. A separate design-doc (`reconciliation.md`) will cover this when reconciliation surfaces land.
