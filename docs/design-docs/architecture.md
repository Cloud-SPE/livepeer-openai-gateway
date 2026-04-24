---
title: Architecture
status: accepted
last-reviewed: 2026-04-24
---

# Architecture

## Layer stack

```
┌─────────────────────────────────────────────────────────┐
│  ui/                admin UI (v2+)                      │  ← may import anything below
├─────────────────────────────────────────────────────────┤
│  runtime/           HTTP, webhook, admin endpoints      │  ← may import service, repo, providers, config, types
│    ├─ http/chat/completions.ts                          │
│    ├─ signup/                                           │
│    ├─ stripeWebhook/                                    │
│    └─ admin/                                            │
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

Enforced by `lint/layer-check` running as an npm script in CI (and via a custom ESLint rule once the plugin is authored).

## Domain inventory

| Path | Purpose |
|---|---|
| `src/service/auth/` | API-key validation, customer record lookup, tier resolution |
| `src/service/billing/` | CustomerLedger reads/writes, top-up orchestration, refund on failure |
| `src/service/routing/` | Router: node selection, failover/retry, request dispatch |
| `src/service/nodes/` | NodeBook loader (config + Postgres state), QuoteRefresher background loop, health checks |
| `src/service/pricing/` | Rate card lookup, margin calculation, drift metrics |
| `src/service/tokenAudit/` | LocalTokenizer coordination — v1 emits drift metrics only |
| `src/service/rateLimit/` | Redis sliding window + concurrent-request semaphore |
| `src/service/payments/` | Wraps PayerDaemon gRPC calls (StartSession, CreatePayment, CloseSession) |

## Runtime surfaces

| Path | Purpose |
|---|---|
| `src/runtime/http/chat/completions.ts` | OpenAI-compatible `/v1/chat/completions`, streaming + non-streaming |
| `src/runtime/signup/` | Email-verified signup, API key issuance |
| `src/runtime/stripeWebhook/` | Handle Stripe events (`payment_intent.succeeded`, disputes) |
| `src/runtime/admin/` | Health, NodeBook inspection, customer ops (manual refund, etc.) |

## Providers inventory

All cross-cutting concerns enter through `src/providers/`. One interface per concern; one or more implementations.

| Provider | Interface role | Default implementation |
|---|---|---|
| `PayerDaemonClient` | gRPC client to local payment daemon (`livepeer.payments.v1`) | `@grpc/grpc-js` with generated stubs |
| `StripeClient` | Top-ups, webhooks, disputes | `stripe` SDK |
| `RedisClient` | Rate-limit state, ephemeral counters | `ioredis` |
| `Database` | Postgres connection pool | `pg` |
| `Tokenizer` | Model-aware token counting (prompt + completion) | `tiktoken` default; per-model-family plugins |
| `ChainInfo` | Read-only Eth for admin views (escrow status) | `viem` |
| `MetricsSink` | Counter / Gauge / Histogram | No-op default; Prometheus later |
| `Logger` | Structured log | `pino` |

Providers are wired in `src/runtime/` entry points and injected into `service/` and `repo/`.

## Build artifacts

- CommonJS/ESM build in `dist/` via `tsc`
- Docker image (later exec-plan)
- Database migration files in `migrations/` (later exec-plan)

## What this architecture does NOT solve

- Horizontal scaling for the OpenAI endpoint. Single-process initially; scale strategy comes with load data.
- Open node discovery (beyond the config-driven allowlist). Deferred to v2.
- Admin UI. `ui/` layer reserved but empty.
- Enterprise/Postpaid tier. Deferred to v2+.
