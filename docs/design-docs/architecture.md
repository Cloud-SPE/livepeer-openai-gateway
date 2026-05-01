---
title: Architecture
status: accepted
last-reviewed: 2026-05-01
---

# Architecture

> **2026-04-30 note:** this doc describes the currently shipped shell
> architecture. The suite's later v3.0.1 protocol cut (no worker
> `/quote`/`/quotes`, `offering`-named resolver inputs, gateway-computed
> `face_value`) is tracked separately in
> [v3-runtime-realignment.md](./v3-runtime-realignment.md).

## Layer stack

The TypeScript server lives under `src/`. Browser UIs (customer portal, operator admin) live in a sibling `frontend/` directory and talk to the bridge over HTTP only — they import nothing from `src/`. See [`ui-architecture.md`](./ui-architecture.md) for the UI stack.

```
┌─────────────────────────────────────────────────────────┐
│  frontend/         browser apps (sibling, not under src/)
│    ├─ shared/         cross-UI primitives
│    ├─ portal/         customer self-service SPA
│    └─ admin/          operator console SPA
└─────────────────────────────────────────────────────────┘
                        ↕ HTTP (no source imports)
┌─────────────────────────────────────────────────────────┐
│  runtime/           HTTP, webhook, admin + portal endpoints  │  ← may import dispatch, service, repo, providers, config, types, interfaces
│    ├─ http/chat/completions.ts  (Fastify wrapper → dispatch/chatCompletion)
│    ├─ http/account/                                     │
│    ├─ http/portal/        @fastify/static for /portal/* │
│    ├─ stripeWebhook/                                    │
│    ├─ admin/                                            │
│    └─ admin/console/      @fastify/static for /admin/console/*
├─────────────────────────────────────────────────────────┤
│  dashboard/         engine's optional read-only operator UI │  ← may import service, providers, interfaces
│                     mounted via registerOperatorDashboard at /admin/ops
├─────────────────────────────────────────────────────────┤
│  dispatch/          framework-free request orchestration (per exec-plan 0025;
│                     current pinned engine path still threads QuoteCache)
│    ├─ chatCompletion.ts       ← current pinned path takes Wallet+Caller+ServiceRegistryClient+CircuitBreaker+QuoteCache
│    ├─ streamingChatCompletion.ts
│    ├─ embeddings.ts                                     │
│    ├─ images.ts                                         │
│    ├─ speech.ts                                         │
│    └─ transcriptions.ts                                 │
├─────────────────────────────────────────────────────────┤
│  service/           business logic                      │  ← may import repo, providers, config, types, interfaces
│    ├─ auth/                                             │
│    ├─ billing/        (incl. inMemoryWallet for tests)  │
│    ├─ routing/        (current pinned path: router, retry, circuitBreaker class, quoteCache, scheduler, quoteRefresher)
│    ├─ (NodeBook + nodes.yaml retired in stage 3 — see node-lifecycle.md)
│    ├─ pricing/                                          │
│    ├─ tokenAudit/                                       │
│    ├─ rateLimit/                                        │
│    └─ payments/                                         │
├─────────────────────────────────────────────────────────┤
│  repo/              Postgres adapters                   │  ← may import providers, config, types
├─────────────────────────────────────────────────────────┤
│  config/            validated config structs            │  ← may import types
├─────────────────────────────────────────────────────────┤
│  types/             Zod schemas, domain types           │  ← imports nothing in src/
└─────────────────────────────────────────────────────────┘

  providers/          cross-cutting interfaces + defaults (engine-internal)
                       incl. serviceRegistry/grpc.ts (ResolverClient → daemon)
  interfaces/         operator-overridable adapter contracts (per exec-plan 0024)
```

## Dependency rule

A module at layer N may import only modules at layers < N, plus `providers/`. No exceptions.

Concretely: `service/routing` may import `service/payments` and
`providers/payerDaemon`, but may not import `runtime/*`,
`@grpc/grpc-js`, or `stripe` directly.

Enforced by the custom ESLint rules in `lint/` (`layer-check`, `no-cross-cutting-import`, `zod-at-boundary`, `no-secrets-in-logs`, `file-size`) wired into `eslint.config.js` and run as part of `npm run lint` in CI.

## Domain inventory

| Path                      | Purpose                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `src/service/auth/`       | API-key validation, customer record lookup, tier resolution                      |
| `src/service/billing/`    | CustomerLedger reads/writes, top-up orchestration, refund on failure             |
| `src/service/routing/`    | Router: node selection, failover/retry, request dispatch                         |
| `src/service/routing/`    | Current pinned engine path: resolver selection, quote refresh/cache, circuit breaker, retry orchestration |
| `src/service/pricing/`    | Rate card lookup, margin calculation, drift metrics                              |
| `src/service/tokenAudit/` | LocalTokenizer coordination — v1 emits drift metrics only                        |
| `src/service/rateLimit/`  | Redis sliding window + concurrent-request semaphore                              |
| `src/service/payments/`   | Wraps payment-daemon gRPC calls (current session bootstrap + CreatePayment flow) |

## Runtime surfaces

| Path                                   | Purpose                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/runtime/http/chat/completions.ts` | OpenAI-compatible `/v1/chat/completions` (non-streaming)                                             |
| `src/runtime/http/chat/streaming.ts`   | OpenAI-compatible `/v1/chat/completions` (SSE streaming)                                             |
| `src/runtime/http/embeddings/`         | OpenAI-compatible `/v1/embeddings`                                                                   |
| `src/runtime/http/images/`             | OpenAI-compatible `/v1/images/generations`                                                           |
| `src/runtime/http/billing/`            | `/v1/billing/topup` for the customer-facing portal                                                   |
| `src/runtime/http/account/`            | `/v1/account/*` — profile, API-keys CRUD, usage rollups, top-up history (powers the customer portal) |
| `src/runtime/http/portal/`             | `@fastify/static` mount serving `frontend/portal/dist/` at `/portal/*`                               |
| `src/runtime/http/stripe/`             | Stripe webhook (`payment_intent.succeeded`, disputes)                                                |
| `src/runtime/http/admin/`              | Health, registry/node inspection, customer ops, search/feed routes (powers the operator console)     |
| `src/runtime/http/admin/console/`      | `@fastify/static` mount serving `frontend/admin/dist/` at `/admin/console/*`                         |
| `src/runtime/http/middleware/`         | Auth + rate-limit middleware shared by every paid route                                              |
| `src/runtime/http/healthz.ts`          | Liveness probe                                                                                       |
| `src/runtime/http/errors.ts`           | Typed error → OpenAI-style response envelope mapping                                                 |

`/v1/audio/speech` and `/v1/audio/transcriptions` (exec-plan 0019) will land in `src/runtime/http/audio/`.

## Providers inventory

All cross-cutting concerns enter through `src/providers/`. One interface per concern; one or more implementations.

| Provider                | Interface role                                                                   | Default implementation                                    |
| ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `PayerDaemonClient`     | gRPC client to local payment-daemon (`livepeer.payments.v1`)                     | `@grpc/grpc-js` with generated stubs                      |
| `NodeClient`            | HTTP client to WorkerNode `/health`, `/v1/*`, and the current pinned quote-refresh path | `fetch`-based impl in `src/providers/nodeClient/`         |
| `StripeClient`          | Top-ups, webhooks, disputes                                                      | `stripe` SDK                                              |
| `RedisClient`           | Rate-limit state, ephemeral counters                                             | `ioredis`                                                 |
| `Database`              | Postgres connection pool                                                         | `pg` + Drizzle ORM                                        |
| `Tokenizer`             | Model-aware token counting (drift audit only — no enforcement in v1)             | `tiktoken` default; per-model-family plugins              |
| `ChainInfo`             | Read-only Eth for admin views (escrow status)                                    | `viem`                                                    |
| `MetricsSink`           | Counter / Gauge / Histogram                                                      | No-op default; Prometheus later                           |
| `ServiceRegistryClient` | Engine-internal node discovery + selection (NOT operator-overridable)            | gRPC client to `livepeer-modules/service-registry-daemon` |

Providers are wired in `src/runtime/` entry points and injected into `service/` and `repo/`.

## Operator-overridable adapters (`src/interfaces/`)

Per exec-plan 0024 (engine-extraction-interfaces), the engine exposes five adapter contracts that operators implement to plug their own billing, auth, rate-limit, logging, and admin-auth into the engine. Distinct from `providers/` (which is engine-internal); operators replace these to integrate, not to extend.

| Adapter             | Role                                                                                                         | Default impl in this repo                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Wallet`            | reserve/commit/refund against the operator's billing model (USD-prepaid, free-quota, postpaid, crypto, etc.) | `createPrepaidQuotaWallet` in `src/service/billing/wallet.ts` — wraps the existing reserve/commit/refund branches |
| `AuthResolver`      | Resolve an inbound HTTP request to a `Caller {id, tier, metadata?}` or null                                  | `createAuthResolver` in `src/service/auth/authResolver.ts` — wraps the existing AuthService                       |
| `RateLimiter`       | Per-caller rate-limit policy enforcement (optional, opt-in at route registration)                            | `createRateLimiter` in `src/service/rateLimit/index.ts` — Redis sliding-window + concurrent-request semaphore     |
| `Logger`            | `info` / `warn` / `error` structured log                                                                     | `createConsoleLogger` in `src/providers/logger/console.ts`                                                        |
| `AdminAuthResolver` | Hook for the engine's optional read-only operator dashboard (lands in stage 2)                               | `createAdminAuthResolver` in `src/service/admin/authResolver.ts` — bearer admin auth + optional `X-Admin-Actor` + IP allowlist   |

A generic `Caller {id, tier, metadata?}` is the engine's view of "who's calling." `metadata` is operator-defined and opaque to the engine; shell-side route handlers narrow via `caller.metadata as AuthenticatedCaller` to reach the customer row, API key, or other shell-specific fields.

## Build artifacts

- CommonJS/ESM build in `dist/` via `tsc`
- Docker image (later exec-plan)
- Database migration files in `migrations/` (later exec-plan)

## What this architecture does NOT solve

- Horizontal scaling for the OpenAI endpoint. Single-process initially; scale strategy comes with load data.
- Open node discovery (beyond the config-driven allowlist). Deferred to v2.
- Enterprise/Postpaid tier. Deferred to v2+.
