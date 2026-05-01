---
title: PayerDaemon integration
status: accepted
last-reviewed: 2026-05-01
---

# PayerDaemon integration

How this shell talks to the `payment-daemon` sidecar from
`livepeer-modules` to acquire signed payment blobs for WorkerNode
requests on the v3 route-first payment flow.

## Scope note

This document describes the current shell/runtime path in this repo:

- resolver `Select(capability, offering, tier)` picks one route
- the bridge computes `face_value`
- the payer daemon sender sidecar signs one payment via
  `CreatePayment(face_value, recipient)`
- the worker validates the attached payment during the real `/v1/*`
  request

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

## Current shell interface

`src/providers/payerDaemon.ts` declares the bridge's domain-level client:

```ts
interface PayerDaemonClient {
  createPayment(input): Promise<CreatePaymentOutput>;
  getDepositInfo(signal?): Promise<DepositInfo>;
  isHealthy(): boolean;
  startHealthLoop(): void;
  stopHealthLoop(): void;
  close(): Promise<void>;
}
```

All inputs and outputs use domain types (`bigint`, `0x`-prefixed hex strings). Protobuf wire types never leak past `providers/payerDaemon/`.

## Sender contract

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

This is the contract the shell consumes today.

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

## Call deadlines and AbortSignal

Every call synthesizes `AbortSignal.any([callerSignal, AbortSignal.timeout(callTimeoutMs)])`. The caller's signal propagates cancellation; the timeout prevents a hung unix-socket call from stalling the request indefinitely. `PAYER_DAEMON_CALL_TIMEOUT_MS` is 5 s by default — overridable via env, and per-call overrides are possible by passing a pre-composed signal.

## Restart semantics

No bridge-local payment session state is persisted across restarts. The
daemon survives naturally — its BoltDB/SQLite store holds balances,
winning tickets, and the escrow watcher state. A restarted bridge
simply resumes route selection and `CreatePayment(...)` calls on the
next customer request.

## What this doc does NOT cover

- How `service/payments.createPaymentForRequest` is stitched into the customer request flow. That's 0007 (non-streaming) and 0008 (streaming).
- The daemon's own lifecycle (binary deployment, keystore passphrase, escrow funding). See `livepeer-modules/payment-daemon/docs/`.
- Reconciliation between CustomerLedger USD, PayerDaemon off-chain EV, and TicketBroker on-chain ETH. A separate design-doc (`reconciliation.md`) will cover this when reconciliation surfaces land.
