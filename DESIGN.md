# DESIGN — openai-livepeer-bridge

## What this is

An OpenAI-compatible HTTP API that fronts a pool of Livepeer WorkerNodes. Customers authenticate with API keys, pay in USD (prepaid balance or quota-capped free tier), and use the standard OpenAI SDK with a custom `base_url`. The bridge routes each request to a WorkerNode, pays the node via the Livepeer payment daemon, and bills the customer.

In the payment-architecture vocabulary this service is a specialized **PayerApp**. It runs a `livepeer-payment-daemon` (sender mode) locally as a sidecar. Customers never see Ethereum, tickets, or wei.

Full architectural reference: [docs/references/openai-bridge-architecture.md](docs/references/openai-bridge-architecture.md).

## Layer stack

```
┌──────────────────────────────────────────────────────────┐
│  ui/           admin UI (v2+)                             │
├──────────────────────────────────────────────────────────┤
│  runtime/      HTTP server, Stripe webhook, admin endpoints│
├──────────────────────────────────────────────────────────┤
│  service/      business logic (auth, billing, routing,    │
│                nodes, pricing, tokenAudit, rateLimit,     │
│                payments)                                  │
├──────────────────────────────────────────────────────────┤
│  repo/         persistence adapters (Postgres)            │
├──────────────────────────────────────────────────────────┤
│  config/       validated config structs                   │
├──────────────────────────────────────────────────────────┤
│  types/        Zod schemas, domain types                  │
└──────────────────────────────────────────────────────────┘

Cross-cutting (through providers/ only):
  PayerDaemonClient, StripeClient, RedisClient, Database,
  Tokenizer, ChainInfo, MetricsSink, Logger
```

Dependency rule: each layer may import only layers **below** it, plus `providers/`. Enforced by a custom ESLint rule. Full detail in [docs/design-docs/architecture.md](docs/design-docs/architecture.md).

## Domains

| Domain | Purpose |
|---|---|
| `service/auth` | API-key validation, customer lookup, tier resolution |
| `service/billing` | CustomerLedger reads/writes, top-up flow, refund |
| `service/routing` | Router: pick a WorkerNode, handle failover and retry |
| `service/nodes` | NodeBook loader + QuoteRefresher + health checks |
| `service/pricing` | Rate card lookup, margin calculation, drift metric |
| `service/tokenAudit` | LocalTokenizer orchestration (v1 metric-only) |
| `service/rateLimit` | Redis sliding window, per-customer limits |
| `service/payments` | PayerDaemon wrapper: CreatePayment, WorkID, session lifecycle |

## Runtime surfaces

| Path | Purpose |
|---|---|
| `src/runtime/http/chat/completions.ts` | OpenAI-compatible `/v1/chat/completions`, streaming + non-streaming |
| `src/runtime/signup/` | Signup + email verification + API key issuance |
| `src/runtime/stripeWebhook/` | Stripe webhook handlers (top-up success, disputes) |
| `src/runtime/admin/` | Ops endpoints (health, NodeBook status, customer lookup) |

## Providers

| Provider | Interface role | Default implementation |
|---|---|---|
| `PayerDaemonClient` | gRPC client to local Livepeer payment daemon | `@grpc/grpc-js` stub |
| `StripeClient` | Top-ups, webhooks, disputes, refunds | `stripe` SDK |
| `RedisClient` | Rate-limit state | `ioredis` |
| `Database` | Postgres pool | `pg` |
| `Tokenizer` | Model-aware token counting | `tiktoken` for OpenAI-compat; per-family plugins |
| `ChainInfo` | Read-only Eth for admin views | `viem` |
| `MetricsSink` | Counter / Gauge / Histogram | No-op default; Prometheus later |
| `Logger` | Structured log | `pino` |

## What this does NOT do

- Does not run inference. WorkerNodes do that.
- Does not hold or validate tickets. The payment daemon does that.
- Does not manage on-chain escrow. Operator does that via direct TicketBroker calls.
- Does not implement all of the OpenAI API. `/v1/chat/completions` only in v1.
