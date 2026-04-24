---
id: 0006
slug: payer-client
title: PayerDaemon gRPC client provider
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Implement `providers/payerDaemon/grpc`: typed gRPC client to the local `livepeer-payment-daemon` (sender mode). Provides session lifecycle and `CreatePayment` calls consumed by `service/payments`.

Depends on: `livepeer.payments.v1` proto (generated from the library repo's exec-plan 0003).

## Non-goals

- No runtime payment daemon discovery. Path is configured; if daemon is down, fail closed.
- No connection pooling to remote daemons. Unix socket only.

## Approach

- [x] Import `livepeer.payments.v1` generated TS stubs via `buf generate` + `ts-proto`; output under `src/providers/payerDaemon/gen/`, committed and excluded from coverage.
- [x] Implement unix-socket gRPC channel (`unix:///path`) with per-call deadline via `AbortSignal.timeout()`; gRPC's built-in reconnect is relied on for transient socket disconnects.
- [x] Wrap `StartSession`, `CreatePayment`, `CloseSession`, `GetDepositInfo` as typed async methods returning domain types (bigint/hex, no protobuf leakage).
- [x] Health check loop: scheduler-injected `GetDepositInfo` ping; two consecutive failures flip `isHealthy()` to false (threshold configurable via env).
- [x] Cancellation-aware: every call composes caller's `AbortSignal` with `AbortSignal.timeout(callTimeoutMs)`.
- [x] `service/payments` wraps this provider with a session cache keyed by `(nodeId, recipient, expirationBlock)`; entries invalidate when the quote expires.
- [x] Author `docs/design-docs/payer-integration.md` — socket contract, error mapping, session lifecycle, fail-closed semantics.

## Decisions log

### 2026-04-24 — Codegen: `buf generate` + `ts-proto` → `@grpc/grpc-js` client

Reason: Need typed stubs for four gRPC RPCs over a unix-socket channel. `ts-proto` generates TypeScript types + service clients that target `@grpc/grpc-js` (real gRPC, unix-socket-friendly via `unix:///path/to/sock` URIs). `@bufbuild/protoc-gen-es` + Connect was rejected because Connect is HTTP/2-only — not unix-socket gRPC. Runtime proto loading (`@grpc/proto-loader`) was rejected because it produces untyped clients, which drifts with schema changes and defeats "Zod at every boundary" for the provider's public surface. `@bufbuild/buf` is pulled in as a pure-JS CLI so no system `protoc` is required.

### 2026-04-24 — Proto source: `../livepeer-payment-library/proto/` at codegen time; generated TS is committed

Reason: The library is not on npm. Generating from the sibling repo's proto dir at `npm run proto:gen`, committing the TS output to `src/providers/payerDaemon/gen/`, and treating it like a pinned snapshot gives us a typed client without coupling the build to an unpublished artifact. Regeneration is explicit (an engineer runs `npm run proto:gen` and reviews the diff). When the library ships a proper npm artifact, we re-decide in a follow-on plan.

### 2026-04-24 — Socket discovery via env var `PAYER_DAEMON_SOCKET`

Reason: Matches how the daemon will be deployed (as a sidecar next to the bridge process). Default `/var/run/livepeer-payment-daemon.sock`. Config file would add a second source of truth for one path; the env var is the simplest shape that works.

### 2026-04-24 — No cross-restart session persistence

Reason: Restart = fresh `work_id` namespace. Session state on PayeeDaemon survives naturally (balances, winning-ticket queues). Persisting `work_id` maps across bridge restarts introduces a second failure mode (stale session IDs that PayerDaemon has forgotten) without meaningful benefit — a restart is already an infrequent event, and the amortization lost by re-opening sessions after a restart is negligible at our scale.

### 2026-04-24 — Error mapping: gRPC status → typed bridge errors

Reason: Keep service/ code free of raw gRPC codes. Mapping:

- `UNAVAILABLE` / `DEADLINE_EXCEEDED` / socket-level errors → `PayerDaemonUnavailableError` (maps to HTTP 503, per core-belief #6 fail-closed).
- `INVALID_ARGUMENT` / `FAILED_PRECONDITION` → `PayerDaemonProtocolError` (our bug or proto drift; HTTP 500).
- `CANCELLED` from caller's AbortSignal → re-thrown as is (let the caller handle cancellation semantics).
- Anything else → generic `PayerDaemonError` carrying the original gRPC code for logging.

Full table in `docs/design-docs/payer-integration.md`.

### 2026-04-24 — Health model: background `GetDepositInfo` ping every 10 s; two failures → unhealthy

Reason: Daemon is a local sidecar — "degraded" rarely makes sense, it's either reachable or not. A simple boolean `isHealthy()` that flips to false after two consecutive ping failures is enough for the fail-closed check in the request path. Ping interval and failure threshold configurable. Scheduler-injected so tests drive the loop deterministically (same pattern as 0005 QuoteRefresher).

### 2026-04-24 — Every call takes an `AbortSignal`, default 5 s deadline

Reason: Required by plan. Gives the runtime a uniform way to cancel an in-flight payment-daemon call when the customer disconnects or a deadline elapses. Default 5 s is generous for a local unix-socket call; per-call overrides allow `CreatePayment` to run longer when tickets batch up. `AbortSignal.any([customerAbort, AbortSignal.timeout(deadline)])` compose pattern at the call site.

## Open questions

- Proto auto-sync: should a CI job in the library repo bump the bridge's generated stubs automatically? Logged in tech-debt; manual `npm run proto:gen` for v1.
- Actual daemon binary integration test: v1 exercises the client against a fake `@grpc/grpc-js` server (same-shaped service descriptor). A real-daemon smoke test is an ops-plan concern.

## Artifacts produced

- Codegen pipeline: `buf.gen.yaml` + `npm run proto:gen`; `@bufbuild/buf` and `ts-proto` as devDeps (no system `protoc` needed).
- Generated stubs (committed): `src/providers/payerDaemon/gen/livepeer/payments/v1/{payer_daemon,payee_daemon,types}.ts`. Excluded from coverage.
- Config: `src/config/payerDaemon.ts` — Zod env (`PAYER_DAEMON_SOCKET`, `PAYER_DAEMON_HEALTH_INTERVAL_MS`, `PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD`, `PAYER_DAEMON_CALL_TIMEOUT_MS`).
- Provider interface: `src/providers/payerDaemon.ts` — domain-level `PayerDaemonClient` with `startSession`, `createPayment`, `closeSession`, `getDepositInfo`, `isHealthy`, health-loop controls, `close`.
- Provider impl: `src/providers/payerDaemon/grpc.ts` — default gRPC client; `convert.ts` (bytes↔bigint/hex); `errors.ts` (`mapGrpcError` + typed errors: `PayerDaemonError`, `PayerDaemonUnavailableError`, `PayerDaemonProtocolError`).
- Service: `src/service/payments/sessions.ts` (cache keyed by `(nodeId, recipient, expirationBlock)`) + `createPayment.ts` (`createPaymentForRequest` composing `getOrStart` and `createPayment`) + `errors.ts` (`QuoteExpiredError`, `PayerDaemonNotHealthyError`).
- Tests (125 total passing, 31 new for 0006; 98.38% stmt / 87.07% branch / 98.63% func / 98.38% line): `src/config/payerDaemon.test.ts`, `src/providers/payerDaemon/{convert,errors,grpc}.test.ts`, `src/service/payments/payments.test.ts`. `grpc.test.ts` spins up a fake `@grpc/grpc-js` server on a unix socket in `os.tmpdir()` and drives startSession → createPayment → closeSession plus health-loop transitions.
- Design-doc: `docs/design-docs/payer-integration.md` (`status: accepted`).
- Tech-debt: proto auto-sync CI check; real-daemon smoke test; npm-publish swap for the library.
