---
id: 0006
slug: payer-client
title: PayerDaemon gRPC client provider
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement `providers/payerDaemon/grpc`: typed gRPC client to the local `livepeer-payment-daemon` (sender mode). Provides session lifecycle and `CreatePayment` calls consumed by `service/payments`.

Depends on: `livepeer.payments.v1` proto (generated from the library repo's exec-plan 0003).

## Non-goals

- No runtime payment daemon discovery. Path is configured; if daemon is down, fail closed.
- No connection pooling to remote daemons. Unix socket only.

## Approach

- [ ] Import `livepeer.payments.v1` generated TS stubs (from proto gen pipeline)
- [ ] Implement unix-socket gRPC connection with reconnect + exponential backoff
- [ ] Wrap `StartSession`, `CreatePayment`, `CloseSession`, `GetDepositInfo` as typed async methods
- [ ] Health check loop: ping daemon periodically; expose `isHealthy()` for fail-closed checks
- [ ] Cancellation-aware: every call takes an `AbortSignal`
- [ ] `service/payments` wraps this provider with session caching (one long-lived session per WorkerNode)
- [ ] Author `docs/design-docs/payer-integration.md` — how payments flow through the bridge

## Decisions log

_(empty)_

## Open questions

- Socket path discovery: env var (`PAYER_DAEMON_SOCKET`), config file, or hard-coded default?
- Session persistence: if the bridge restarts, do we preserve session IDs or start fresh? Fresh is safer; existing balances on the PayeeDaemon side naturally survive.
- Error mapping: gRPC status codes → bridge error types. Document in `design-docs/`.
- How does the bridge know the proto definitions? Published npm package, generated per-build from library repo, or pinned in the library repo's artifacts?

## Artifacts produced

_(to be populated on completion)_
