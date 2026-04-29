---
title: PayerDaemon integration (gRPC client, sessions, payments)
status: accepted
last-reviewed: 2026-04-25
---

# PayerDaemon integration

How the bridge talks to `livepeer-payment-library`'s PayerDaemon sidecar to acquire signed payment blobs for WorkerNode requests.

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

- Proto lives in the sibling repo `../livepeer-payment-library/proto/`.
- `npm run proto:gen` runs `buf generate` with `ts-proto`; output lives under `src/providers/payerDaemon/gen/` and is committed.
- Regenerate explicitly when the library's `livepeer.payments.v1` proto changes. The generated folder is excluded from coverage (`vitest.config.ts`).

## Provider interface

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

### `startSession` requires `priceInfo` (since payment-daemon v0.8.10)

`StartSessionInput` carries a REQUIRED `priceInfo` field — the per-capability `cap.maxPrice` the worker used at quote time, surfaced as the max in `/quote.model_prices` and projected onto `Quote.priceInfo` by `wireQuoteToDomain`. The bridge passes it as the matching `StartSessionRequest.price_info` (proto field 3); the sender daemon stamps it into `Payment.expected_price` for every subsequent `CreatePayment`. The receiver re-derives `recipientRand` from the price as part of its HMAC inputs, so the value MUST match the price the worker used to issue the `TicketParams` — anything else 402s with `validator: invalid recipientRand for recipientRandHash`.

In practice: `service/payments/sessions.ts::createSessionCache.getOrStart` reads `quote.priceInfo` (already populated by `wireQuoteToDomain`) and passes `{pricePerUnit: quote.priceInfo.pricePerUnitWei, pixelsPerUnit: quote.priceInfo.pixelsPerUnit}` on every `startSession` call. There is currently no bridge-side affordance for "free / bootstrap" sessions; the daemon expects the canonical-zero `{0, 1}` to indicate that and the bridge always passes a real price (the worker.yaml's `price_per_work_unit_wei` is the source). Tracked library-side as `bootstrap-session-explicit-price`.

Cross-reference: [livepeer-payment-library wire-compat.md](https://github.com/Cloud-SPE/livepeer-modules/blob/main/payment-daemon/docs/design-docs/wire-compat.md#startsessionrequestprice_info-is-required-on-every-non-bootstrap-session) and [redemption-loop.md "Ticket recipientRand derivation"](https://github.com/Cloud-SPE/livepeer-modules/blob/main/payment-daemon/docs/design-docs/redemption-loop.md#ticket-recipientrand-derivation).

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

## Session lifecycle

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

No state is persisted across bridge restarts. Fresh process = fresh session namespace. The daemon survives naturally — its BoltDB/SQLite store holds balances, winning tickets, and the escrow watcher state. A restarted bridge reopens sessions via `startSession` on the next customer request.

## What this doc does NOT cover

- How `service/payments.createPaymentForRequest` is stitched into the customer request flow. That's 0007 (non-streaming) and 0008 (streaming).
- The daemon's own lifecycle (binary deployment, keystore passphrase, escrow funding). See `livepeer-payment-library/docs/`.
- Reconciliation between CustomerLedger USD, PayerDaemon off-chain EV, and TicketBroker on-chain ETH. A separate design-doc (`reconciliation.md`) will cover this when reconciliation surfaces land.
