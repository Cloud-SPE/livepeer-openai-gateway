---
title: Architecture
status: accepted
last-reviewed: 2026-04-26
---

# Architecture

## Layer stack

The TypeScript server lives under `src/`. Browser UIs (customer portal, operator admin) live in a sibling `bridge-ui/` directory and talk to the bridge over HTTP only — they import nothing from `src/`. See [`ui-architecture.md`](./ui-architecture.md) for the UI stack.

```
┌─────────────────────────────────────────────────────────┐
│  bridge-ui/         browser apps (sibling, not under src/)
│    ├─ shared/         cross-UI primitives
│    ├─ portal/         customer self-service SPA
│    └─ admin/          operator console SPA
└─────────────────────────────────────────────────────────┘
                        ↕ HTTP (no source imports)
┌─────────────────────────────────────────────────────────┐
│  runtime/           HTTP, webhook, admin + portal endpoints  │  ← may import service, repo, providers, config, types
│    ├─ http/chat/completions.ts                          │
│    ├─ http/account/                                     │
│    ├─ http/portal/        @fastify/static for /portal/* │
│    ├─ stripeWebhook/                                    │
│    ├─ admin/                                            │
│    └─ admin/console/      @fastify/static for /admin/console/*
├─────────────────────────────────────────────────────────┤
│  service/           business logic                      │  ← may import repo, providers, config, types
│    ├─ auth/                                             │
│    ├─ billing/                                          │
│    ├─ routing/                                          │
│    ├─ nodes/                                            │
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

  providers/          cross-cutting interfaces + defaults
```

## Dependency rule

A module at layer N may import only modules at layers < N, plus `providers/`. No exceptions.

Concretely: `service/routing` may import `service/nodes`, `service/payments`, and `providers/payerDaemon`, but may not import `runtime/*`, `@grpc/grpc-js`, or `stripe` directly.

Enforced by the custom ESLint rules in `lint/` (`layer-check`, `no-cross-cutting-import`, `zod-at-boundary`, `no-secrets-in-logs`, `file-size`) wired into `eslint.config.js` and run as part of `npm run lint` in CI.

## Domain inventory

| Path                      | Purpose                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `src/service/auth/`       | API-key validation, customer record lookup, tier resolution                              |
| `src/service/billing/`    | CustomerLedger reads/writes, top-up orchestration, refund on failure                     |
| `src/service/routing/`    | Router: node selection, failover/retry, request dispatch                                 |
| `src/service/nodes/`      | NodeBook loader (config + Postgres state), QuoteRefresher background loop, health checks |
| `src/service/pricing/`    | Rate card lookup, margin calculation, drift metrics                                      |
| `src/service/tokenAudit/` | LocalTokenizer coordination — v1 emits drift metrics only                                |
| `src/service/rateLimit/`  | Redis sliding window + concurrent-request semaphore                                      |
| `src/service/payments/`   | Wraps PayerDaemon gRPC calls (StartSession, CreatePayment, CloseSession)                 |

## Runtime surfaces

| Path                                   | Purpose                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/http/chat/completions.ts` | OpenAI-compatible `/v1/chat/completions` (non-streaming)                                                                                                |
| `src/runtime/http/chat/streaming.ts`   | OpenAI-compatible `/v1/chat/completions` (SSE streaming)                                                                                                |
| `src/runtime/http/embeddings/`         | OpenAI-compatible `/v1/embeddings`                                                                                                                      |
| `src/runtime/http/images/`             | OpenAI-compatible `/v1/images/generations`                                                                                                              |
| `src/runtime/http/billing/`            | `/v1/billing/topup` for the customer-facing portal                                                                                                      |
| `src/runtime/http/account/`            | `/v1/account/*` — profile, API-keys CRUD, usage rollups, top-up history (powers the customer portal)                                                    |
| `src/runtime/http/portal/`             | `@fastify/static` mount serving `bridge-ui/portal/dist/` at `/portal/*`                                                                                 |
| `src/runtime/http/stripe/`             | Stripe webhook (`payment_intent.succeeded`, disputes)                                                                                                   |
| `src/runtime/http/admin/`              | Health, NodeBook inspection, customer ops, search/feed routes (powers the operator console)                                                             |
| `src/runtime/http/admin/console/`      | `@fastify/static` mount serving `bridge-ui/admin/dist/` at `/admin/console/*`                                                                          |
| `src/runtime/http/middleware/`         | Auth + rate-limit middleware shared by every paid route                                                                                                 |
| `src/runtime/http/healthz.ts`          | Liveness probe                                                                                                                                          |
| `src/runtime/http/errors.ts`           | Typed error → OpenAI-style response envelope mapping                                                                                                    |

`/v1/audio/speech` and `/v1/audio/transcriptions` (exec-plan 0019) will land in `src/runtime/http/audio/`.

## Providers inventory

All cross-cutting concerns enter through `src/providers/`. One interface per concern; one or more implementations.

| Provider            | Interface role                                                                          | Default implementation                       |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| `PayerDaemonClient` | gRPC client to local payment daemon (`livepeer.payments.v1`)                            | `@grpc/grpc-js` with generated stubs         |
| `NodeClient`        | HTTP client to WorkerNode `/health`, `/capabilities`, `/quote`, `/quotes`, `/v1/*`      | `fetch`-based impl in `src/providers/nodeClient/` |
| `StripeClient`      | Top-ups, webhooks, disputes                                                             | `stripe` SDK                                 |
| `RedisClient`       | Rate-limit state, ephemeral counters                                                    | `ioredis`                                    |
| `Database`          | Postgres connection pool                                                                | `pg` + Drizzle ORM                           |
| `Tokenizer`         | Model-aware token counting (drift audit only — no enforcement in v1)                    | `tiktoken` default; per-model-family plugins |
| `ChainInfo`         | Read-only Eth for admin views (escrow status)                                           | `viem`                                       |
| `MetricsSink`       | Counter / Gauge / Histogram                                                             | No-op default; Prometheus later              |
| `Logger`            | Structured log                                                                          | `pino`                                       |

Providers are wired in `src/runtime/` entry points and injected into `service/` and `repo/`.

## Build artifacts

- CommonJS/ESM build in `dist/` via `tsc`
- Docker image (later exec-plan)
- Database migration files in `migrations/` (later exec-plan)

## What this architecture does NOT solve

- Horizontal scaling for the OpenAI endpoint. Single-process initially; scale strategy comes with load data.
- Open node discovery (beyond the config-driven allowlist). Deferred to v2.
- Enterprise/Postpaid tier. Deferred to v2+.
