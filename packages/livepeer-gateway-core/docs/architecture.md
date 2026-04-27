# Architecture

This document covers the engine's internal structure: the layer
stack, the dispatcher pipeline, the payment-daemon integration, and
the metric surface. For the operator-facing adapter contracts, see
[`adapters.md`](adapters.md).

## Layer stack

Imports flow strictly downward; the `livepeer-bridge/layer-check`
ESLint rule fails CI on a violation.

```
┌──────────────────────────────────────────────────────────────────────┐
│                              types/                                   │
│   Zod schemas + branded TS types. No runtime deps beyond zod.         │
└──────────────────────────────────────────────────────────────────────┘
       ↑
┌──────┴───────────────────────────────────────────────────────────────┐
│                              config/                                  │
│   Env-var loaders. Each Zod-validated; throws on invalid env. main()  │
│   decides the failure mode.                                           │
└──────────────────────────────────────────────────────────────────────┘
       ↑
┌──────┴───────────────────────────────────────────────────────────────┐
│                              repo/                                    │
│   Drizzle-backed query helpers. Schema namespaced as `engine.*`.      │
│   `engine.usage_records.caller_id` is opaque TEXT — no FK to any      │
│   operator schema.                                                    │
└──────────────────────────────────────────────────────────────────────┘
       ↑
┌──────┴───────────────────────────────────────────────────────────────┐
│                            service/                                   │
│   payments, routing (selectNode, circuitBreaker, quoteCache,          │
│   quoteRefresher, scheduler), pricing, tokenAudit, rateLimit,         │
│   metrics, admin/{engine, basicAuthResolver}, billing/inMemoryWallet. │
│   Cross-domain composition is the layer-above's job.                  │
└──────────────────────────────────────────────────────────────────────┘
       ↑
┌──────┴───────────────────────────────────────────────────────────────┐
│                  runtime/  +  dispatch/                               │
│   runtime/http/* — Fastify route registers + auth/rate-limit/error    │
│     middleware. Composition root for HTTP.                            │
│   runtime/metrics/server.ts — Prometheus scrape endpoint.             │
│   dispatch/* — protocol-correct dispatchers (chat, embeddings,        │
│     images, audio speech + transcriptions). Pure functions over       │
│     interfaces; no Fastify dependency.                                │
└──────────────────────────────────────────────────────────────────────┘

       providers/ ── cross-cutting; reachable from every layer above.
       database/, http/, logger/, metrics/, nodeClient/, payerDaemon/,
       redis/, serviceRegistry/, tokenizer/.
```

`interfaces/` lives outside the layer stack — it holds the five
operator-overridable adapter contracts (`Wallet`, `AuthResolver`,
`RateLimiter`, `Logger`, `AdminAuthResolver`) plus the engine-internal
`Caller` / `CostQuote` / `UsageReport` shapes the dispatchers thread
around. Any layer may import from `interfaces/`.

## Dispatcher pipeline

Every capability follows the same six-step pipeline. The shape of
each step is fixed; only the protocol details (what the worker
returns, how tokens are counted) vary.

```
1. Auth          AuthResolver.resolve(req.headers)             → Caller | null
                 401 on null; AuthError on thrown subclasses.

2. Rate-limit    RateLimiter.check(caller.id, caller.tier)     → RateLimitResult
                 429 on RateLimitExceededError; reply.raw 'close' calls release().

3. Reserve       Wallet.reserve(caller, costQuote)             → ReservationHandle | null
                 null = postpaid (no upfront authorization).
                 BalanceInsufficientError → 402.
                 QuotaExceededError → 429 with insufficient_quota code.

4. Select node   ServiceRegistryClient.select({capability, model, tier})
                                                               → NodeRef[]
                 - Daemon does most of the work via Select RPC.
                 - Bridge filters out CircuitBreaker.currentExclusions(now).
                 - Weighted-random pick on NodeRef.weight.
                 - NoHealthyNodesError → 503 model_unavailable.

5. Call worker   NodeClient.call<capability>(url, request, payment)
                                                               → response, usage
                 - payment from PaymentsService (signed by payer-daemon).
                 - On non-2xx: CircuitBreaker.onFailure; retry with the next
                   node up to RoutingConfig.retry.maxAttempts.
                 - Token audit on response: compare reported vs. local count;
                   emit token_drift_percent + tokens_local_count + tokens_reported_count.

6. Commit        Wallet.commit(caller, handle, usageReport)    → void
                 Wallet.refund(caller, handle, reason) on failure.
                 engine.usage_records row written either way.
                 Response shipped to client.
```

Each step is one or two function calls into a service module. The
pipeline lives in `dispatch/<capability>.ts` (~150 LOC each); the
Fastify glue lives in `runtime/http/<capability>/<verb>.ts`
(~50 LOC each, mostly Zod parse + dispatcher invocation + error
mapping).

## Worker call protocol

Workers are HTTP endpoints implementing a fixed contract:

- `GET /health` — readiness probe + capability advertisement.
- `GET /quotes?sender=<bridgeEthAddress>` — batched quotes per
  capability, with TicketParams + price bands. The
  `quoteRefresher` polls this on a schedule and writes results to
  `QuoteCache`.
- `POST /v1/<capability>` — protocol call. Body is OpenAI-shaped;
  payment travels in headers (`X-Livepeer-Payment` is the
  base64url-encoded signed ticket bytes from the payer-daemon).
- Response is OpenAI-shaped; usage / actual-tokens reported in the
  body or in headers, depending on the capability.

The exact contract per capability lives in
[`design-docs/payer-integration.md`](design-docs/payer-integration.md)
once that doc is committed.

## Payment-daemon integration

The payment-daemon is a separate process, owned by
[`livepeer-modules-project/livepeer-payment-library`](https://github.com/livepeer-modules-project/livepeer-payment-library).
It runs in **sender mode** alongside the engine; the engine talks to
it over a unix-domain gRPC socket.

The engine pins three RPCs:

- `StartSession` — opens a session with a worker; returns a
  `work_id` the engine uses as an idempotency key all the way
  through the dispatch.
- `CreatePayment` — produces a signed ticket for a given quote.
  Bytes are then base64url-encoded into the worker request header.
- `CloseSession` — releases session state on the daemon side after
  commit/refund.

The payer-daemon handles all keystore mechanics, ticket signing,
expiration-block tracking, and on-chain interaction with the
TicketBroker contract. The engine never touches an Ethereum RPC
directly.

A periodic health probe (`payerDaemon.startHealthLoop()`) detects
daemon outages and surfaces them via
`livepeer_bridge_payer_daemon_calls_total` /
`livepeer_bridge_payer_daemon_call_duration_seconds` and via the
`payerDaemon.isHealthy()` flag the operator dashboard surfaces.

## Service-registry-daemon integration

The service-registry-daemon is a separate process, owned by
[`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon).
It runs in **resolver mode** alongside the engine.

The engine pins four RPCs:

- `Select(capability, model, tier, ...)` — the daemon's selection
  algorithm. Returns ranked `NodeRef[]`. Engine adds bridge-local
  circuit-breaker exclusion + weighted-random pick.
- `ListKnown(capability?)` — full set of known nodes. Engine
  populates its `NodeIndex` once at startup from this.
- `ResolveByAddress(ethAddress, ...)` — used by the daemon's own
  `ListKnown` impl for fan-out resolution (engine doesn't call
  directly).
- `Health()` — periodic probe; populates the
  `serviceRegistry.isHealthy()` flag.

The engine does NOT support a static-YAML node-pool fallback.
Running without the registry-daemon is unsupported.

## Database schema

The engine owns three tables in its own Postgres schema. Defined in
`migrations/0000_engine_init.sql`:

- `engine.node_health` — current circuit-breaker state per node
  (status, consecutive failures, last success/failure timestamps,
  circuit-opened-at).
- `engine.node_health_events` — append-only log of breaker
  transitions (`circuit_opened`, `circuit_half_opened`,
  `circuit_closed`, `config_reloaded`,
  `eth_address_changed_rejected`).
- `engine.usage_records` — per-request log with `caller_id` (opaque
  TEXT), `work_id` (engine idempotency key), model, capability,
  token counts (reported + local), cost (USD cents + node cost
  in wei), status, error code, timestamp.

There are NO foreign keys from `engine.*` into any operator schema.
Operators wire their own tables (`app.customers`, `app.reservations`,
`app.api_keys`, etc.) and the shell decides whether to join across
schemas in queries.

## Metric surface

All engine metrics live under the `livepeer_bridge_*` prefix. The
[`metrics.md`](design-docs/metrics.md) design doc has the full
catalog; the highlights:

- `livepeer_bridge_requests_total` — labeled by capability, model,
  tier, outcome.
- `livepeer_bridge_request_duration_seconds` — histogram with
  default buckets.
- `livepeer_bridge_node_requests_total` /
  `livepeer_bridge_node_request_duration_seconds` — outbound
  worker calls labeled by node_id + outcome.
- `livepeer_bridge_node_circuit_transitions_total` — circuit
  breaker state changes per node.
- `livepeer_bridge_node_quote_age_seconds` — gauge per
  (node, capability), 0 immediately after a successful refresh.
- `livepeer_bridge_payer_daemon_calls_total` /
  `livepeer_bridge_payer_daemon_call_duration_seconds`.
- `livepeer_bridge_node_cost_wei_total` — cumulative node-side cost.
- `livepeer_bridge_revenue_usd_cents_total` — cumulative engine-side
  revenue.
- `livepeer_bridge_token_drift_percent` /
  `livepeer_bridge_token_count_local_total` /
  `livepeer_bridge_token_count_reported_total` — token audit.
- `livepeer_bridge_engine_build_info` — constant-1 gauge labeled
  with version/env/Node version.

The shell ships its own `cloudspe_*` prefix for Stripe + top-up +
reservations metrics (the `cloudspe_app_build_info` gauge is set
via `setShellBuildInfo()`). Operators composing under a different
brand can emit under their own prefix by reaching into the same
prom-client `Registry` the engine exposes.

A `CapVec` cardinality cap protects every label vec — once the
configured `maxSeriesPerMetric` is hit, new label tuples drop
silently and a single `onCapExceeded` callback fires per metric.
Operators wire this to a structured logger so the violation is
loud.

## Configuration surface

All configuration is env-var-driven (Zod-validated at startup).
Loaders live under `src/config/`:

- `database` — Postgres connection.
- `redis` — Redis connection (rate-limit storage).
- `payerDaemon` — payer-daemon socket + health-probe knobs +
  `BRIDGE_ETH_ADDRESS`.
- `serviceRegistry` — registry-daemon socket + health-probe knobs.
- `pricing` — rate cards (chat, embeddings, images).
- `routing` — quote-refresh interval, health/quote timeouts,
  circuit-breaker policy.
- `rateLimit` — default tier policies (concurrency + sliding window).
- `metrics` — Prometheus listener address + cardinality cap.
- `tokenizer` — preload list of known tiktoken encodings.

Per-operator concerns (auth pepper, Stripe keys, admin token)
belong in the operator's own config layer, not in the engine.

## See also

- [`adapters.md`](adapters.md) — long-form adapter contracts.
- [`design-docs/`](design-docs/) — focused notes per topic
  (node lifecycle, payer integration, pricing model, streaming
  semantics, token audit, retry policy, metrics catalog,
  operator dashboard).
- [`../examples/minimal-shell/`](../examples/minimal-shell/) — the
  smallest runnable wiring of all the above.
