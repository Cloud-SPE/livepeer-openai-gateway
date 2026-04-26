---
title: Bridge metrics catalog
status: accepted
last-reviewed: 2026-04-25
---

# Bridge metrics catalog

What `openai-livepeer-bridge` exposes on `/metrics` and why each metric exists. The bridge is the only place in the stack where USD, customer identity, and node identity all meet — so this is the catalog where business metrics live and where cross-repo reconciliation is computed.

Every metric pairs to a question someone (SRE, finance, or product) will dashboard or alert on. No vanity metrics.

**Cross-repo conventions**: [`../../../livepeer-modules-conventions/metrics-conventions.md`](../../../livepeer-modules-conventions/metrics-conventions.md). This doc covers bridge-specific instantiation; the conventions doc covers cross-repo rules (naming, label keys, bucket presets, cardinality cap, dual-histogram, audit-log philosophy, provider boundary).

The pattern mirrors [`livepeer-service-registry`'s observability](../../../livepeer-service-registry/docs/design-docs/observability.md) (status `verified`) — adapted for TypeScript / Fastify / `prom-client`. Same `livepeer_<repo>_*` prefix.

Phases:

- **Phase 1** (this doc, in-scope to build): `prom-client` Recorder + `/metrics` endpoint + ~16 metrics covering customer request path, money/ledger, node pool, PayerDaemon, and DB/Redis-derived gauges. Closes the Prometheus-side of [`operator-economics-metrics-tooling`](../exec-plans/tech-debt-tracker.md#operator-economics-metrics-tooling) item 4 and lays the foundation for items 1–3.
- **Phase 2**: streaming TTFT, partial-stream accounting, drift-violation counter, customer-balance distribution sweep, ledger leak detector, retry-by-reason breakdowns.
- **Phase 3**: SQL-backed `GET /admin/metrics/{daily,per-worker,per-tier,request/:work_id}` rollups (items 1–3 + 6 of `operator-economics-metrics-tooling`) + static dashboard (item 7). No new Prometheus metrics — operator-facing JSON / HTML, sourced from `usage_record` + `topup` SQL.

## Conventions (bridge-specific)

The cross-repo conventions doc covers: prefix (`livepeer_bridge_*`), bucket presets (Default + Fast), cardinality cap (`METRICS_MAX_SERIES_PER_METRIC` default `10000`), dual-histogram pattern for gRPC, forbidden labels, audit-log-vs-label rule, provider boundary.

Bridge-specific:

- **Allowed labels (this repo)**: `capability`, `model`, `tier`, `node_id`, `outcome`, `reason`, `state`, `kind`, `method`, `event_type`. `tier` ∈ {free, starter, standard, pro, premium}; `node_id` is allowlisted in `nodes.yaml`.
- **Per-entity drilldown**: `usage_record` SQL table for per-request history; `admin_audit_event` for operator-action history. Never label by `customer_id`, `api_key_id`, `work_id`, `stripe_session_id`, `email`, IP.
- **Endpoint**: `METRICS_LISTEN` env (e.g. `127.0.0.1:9602`, port `:9602` per [`port-allocation.md`](../../../livepeer-modules-conventions/port-allocation.md)). Off by default. Separate Fastify instance from the customer-facing API — never expose `/metrics` to the public internet.
- **Legacy unprefixed metrics from `0011-local-tokenizer-metric.md`**: Phase 1 emits both `tokens_drift_percent` (deprecated) and `livepeer_bridge_token_drift_percent` for one release window. Phase 2 deletes the unprefixed name.

## Phase 1 catalog

### Customer request path

| Question | Metric | Type | Labels |
|---|---|---|---|
| Per-capability customer-visible latency | `livepeer_bridge_request_duration_seconds` | histogram (Default buckets) | `capability`, `model`, `tier`, `outcome` |
| Per-capability request accounting | `livepeer_bridge_requests_total` | counter | `capability`, `model`, `tier`, `outcome={2xx,4xx,402,429,5xx}` |
| Why are requests being rate-limited? | `livepeer_bridge_rate_limit_rejections_total` | counter | `tier`, `kind={rpm,rpd,concurrent}` |
| Are retries succeeding or just churning? | `livepeer_bridge_node_retries_total` | counter | `reason={timeout,5xx,quote_expired,circuit_open}`, `attempt={1,2,3}` |

`livepeer_bridge_request_duration_seconds` is the most-looked-at metric here — the only one customers can effectively SLO against. Phase 1 keeps the outcome bucket coarse; Phase 2 splits 5xx into root-cause classes if dashboards demand it.

`livepeer_bridge_node_retries_total` answers "is the retry policy hiding flapping nodes from customers, or just churning?" If `attempt=3` is non-trivial relative to `attempt=1`, the node pool is unhealthy and customers pay with latency.

### Money & ledger

| Question | Metric | Type | Labels |
|---|---|---|---|
| Revenue collected (per cut) | `livepeer_bridge_revenue_usd_cents_total` | counter | `capability`, `model`, `tier` |
| What did I pay nodes? | `livepeer_bridge_node_cost_wei_total` | counter | `capability`, `model`, `node_id` |
| Are top-ups completing? Stuck? | `livepeer_bridge_topups_total` | counter | `outcome={initiated,succeeded,failed,disputed,refunded}` |
| Are reservations stalling (commit/refund leak)? | `livepeer_bridge_reservations_open` (gauge), `livepeer_bridge_reservation_open_oldest_seconds` (gauge) | gauge | — |
| Stripe webhook health | `livepeer_bridge_stripe_webhooks_total` (counter), `livepeer_bridge_stripe_webhook_duration_seconds` (hist) | counter, hist | `event_type`, `outcome={processed,duplicate,signature_invalid,handler_error}` |

`livepeer_bridge_revenue_usd_cents_total` and `livepeer_bridge_node_cost_wei_total` together drive the gross-margin dashboard. Same `(capability, model)` labels on both means a join works directly. Only the bridge knows both halves.

`livepeer_bridge_reservations_open` is the **ledger leak canary**. A reservation flips to committed-or-refunded within seconds of the request finishing. If `livepeer_bridge_reservation_open_oldest_seconds > 5min`, something is wrong (stalled commit, crashed handler, customer balance temporarily locked). Sampled every 30 s.

### Node pool

| Question | Metric | Type | Labels |
|---|---|---|---|
| How many nodes are usable right now? | `livepeer_bridge_nodes_state` | gauge | `state={healthy,degraded,circuit_broken,disabled}` |
| Per-node success rate | `livepeer_bridge_node_requests_total` | counter | `node_id`, `outcome` |
| Per-node latency | `livepeer_bridge_node_request_duration_seconds` | histogram (Default buckets) | `node_id`, `outcome` |
| Are quotes going stale? | `livepeer_bridge_node_quote_age_seconds` | gauge | `node_id`, `capability` |
| Circuit churn (signals a flapping node) | `livepeer_bridge_node_circuit_transitions_total` | counter | `node_id`, `to_state` |

`livepeer_bridge_nodes_state` is a count gauge labeled by state — `sum(livepeer_bridge_nodes_state{state="healthy"})` gives the healthy-node count. Per-node detail lives in `livepeer_bridge_node_requests_total{node_id}`. Avoids the cardinality of one gauge per node × per state.

### PayerDaemon (the bridge-side client view)

| Question | Metric | Type | Labels |
|---|---|---|---|
| PayerDaemon RPC accounting | `livepeer_bridge_payer_daemon_calls_total` | counter | `method`, `outcome` |
| PayerDaemon RPC latency (default range) | `livepeer_bridge_payer_daemon_call_duration_seconds` | histogram (Default buckets) | `method` |
| PayerDaemon RPC latency (sub-ms detail) | `livepeer_bridge_payer_daemon_call_duration_seconds_fast` | histogram (Fast buckets) | `method` |
| Bridge-side view of escrow | `livepeer_bridge_payer_daemon_deposit_wei`, `livepeer_bridge_payer_daemon_reserve_wei` | gauge | — |

Dual-histogram per the conventions doc — both observe every gRPC call. The daemon also exposes its own server-side `livepeer_payment_grpc_*` (see [`../../../livepeer-payment-library/docs/design-docs/metrics.md`](../../../livepeer-payment-library/docs/design-docs/metrics.md)). Both views are valuable: server-side captures the daemon's view; client-side here includes socket overhead. A persistent gap means the unix-socket is slow.

`method` values: `StartSession`, `CreatePayment`, `CloseSession`, `GetDepositInfo`.

### Token audit (existing — Phase 1 renames + dual-emits for one release)

| Question | Metric | Type | Labels |
|---|---|---|---|
| Is any node systematically over/under-reporting tokens? | `livepeer_bridge_token_drift_percent` (renamed from `tokens_drift_percent`) | histogram | `node_id`, `model`, `direction={prompt,completion}` |
| Local vs. reported token counts | `livepeer_bridge_token_count_local_total`, `livepeer_bridge_token_count_reported_total` | counter | `node_id`, `model`, `direction` |

These exist today as gauges (`tokens_local_count` / `tokens_reported_count`); Phase 1 also flips them to counters since they're cumulative event counts, not point-in-time values. Legacy unprefixed names emitted in parallel for one release.

### Build / health

| Metric | Type | Labels |
|---|---|---|
| `livepeer_bridge_build_info` | gauge=1 | `version`, `node_env`, `node_version` |

Standard `process_*` and `nodejs_*` collectors (built-in to `prom-client`) handle uptime, event-loop lag, GC, heap.

## Phase 2 catalog (additive)

| Question | Metric | Type | Labels |
|---|---|---|---|
| Streaming TTFT | `livepeer_bridge_stream_ttft_seconds` | histogram | `capability`, `model` |
| Stream lifecycle outcomes | `livepeer_bridge_streams_total` | counter | `capability`, `model`, `outcome={completed,partial,failed,client_canceled}` |
| Token-drift threshold violations | `livepeer_bridge_token_drift_violations_total` | counter | `node_id`, `model`, `threshold={5pct,10pct}` |
| Customer balance distribution (sampled, no per-customer label) | `livepeer_bridge_customer_balance_usd_cents` | histogram | `tier` |
| Free-tier quota exhaustion | `livepeer_bridge_quota_exhausted_total` | counter | — |
| Customer tier transitions (free→prepaid upgrade signal) | `livepeer_bridge_customer_tier_transitions_total` | counter | `from`, `to` |

`livepeer_bridge_customer_balance_usd_cents` is a periodic sample (every ~5 min over `SELECT balance_usd_cents FROM customer WHERE tier='prepaid' AND status='active'`). Histogram bucket counts answer "what fraction of paying customers are under $1?" without ever labeling by customer.

`livepeer_bridge_token_drift_violations_total` is the alerting hook for the existing observe-only drift histogram — a node consistently > 5% drift is a candidate for circuit break.

## Phase 3 (no new Prometheus metrics)

Phase 3 ships the **operator rollups** from [`operator-economics-metrics-tooling`](../exec-plans/tech-debt-tracker.md#operator-economics-metrics-tooling). All SQL-backed against existing tables.

- `GET /admin/metrics/daily?days=7` — customer revenue, node EV paid, per-tier request count, per-tier net margin.
- `GET /admin/metrics/per-worker` — per-`node_id` tokens served, EV paid, utilization %, circuit state.
- `GET /admin/metrics/per-tier` — realized $/M tokens by tier.
- `GET /admin/metrics/request/:work_id` — full per-request join: `usage_record` + ticket batch ID + on-chain redemption tx hash.
- Static HTML dashboard auto-regenerated nightly.

## Cross-repo reconciliation (the dashboards Phase 1 enables)

The reason Phase 1 labels `(capability, model, node_id)` consistently across the four repos is so the following reconciliation panels work as plain Prom queries — no new metrics required.

| Panel | Source A | Source B | Drift means… |
|---|---|---|---|
| Customer-paid USD ↔ Node-paid wei × ETH/USD | `livepeer_bridge_revenue_usd_cents_total` | `livepeer_bridge_node_cost_wei_total` × ETH/USD | Margin per `tier` × `model`. Sustained < 20 % margin = price-card review. |
| Bridge wei sent ↔ Worker-side EV credited | `livepeer_bridge_node_cost_wei_total{node_id=X}` × (EV/face-value ratio) | sum across worker `livepeer_payment_tickets_total{outcome=accepted+winner}` × per-ticket faceValue (logs / Phase 2 `livepeer_payment_face_value_wei`) | Should match per (node, window). Sustained gap = wire-format / price-info bug — see daemon tracker `bootstrap-session-explicit-price`. |
| Worker units served ↔ Bridge units billed | `livepeer_worker_work_units_total{capability,model}` | `livepeer_bridge_revenue_usd_cents_total ÷ rate-card` for same (capability, model) | Should match exactly. Drift = tokenizer disagreement (covered today by `livepeer_bridge_token_drift_percent`) OR billing bug. |
| Credited EV ↔ Redeemed face-value (probabilistic) | `livepeer_payment_tickets_total{outcome=winner}` × per-ticket faceValue | `livepeer_payment_redemption_redeemed_face_value_wei_total` | Should converge over weeks (probabilistic settlement). Persistent shortfall = redemption-loop dropping winners. |

Three-way reconciliation on the same hop is the whole point of building all three repos with consistent labels at the same time. It's also the thing operators historically have to script by hand against logs + SQL — this lets it be one Grafana panel.

## What we deliberately do NOT measure

- **Per-customer balance gauges.** Cardinality bomb. Use `livepeer_bridge_customer_balance_usd_cents` histogram (Phase 2) for distribution, SQL on `customer` for individuals.
- **Per-API-key counters.** Same.
- **Per-route Fastify timers** (when the `livepeer_bridge_requests_total` matrix already covers it). Don't double-instrument the same hop.
- **DB connection pool / Redis memory.** `pg_exporter` and `redis_exporter` exist — run them.
- **Admin endpoint hit counters.** `admin_audit_event` is the audit log — Prometheus is not the place for "did anyone use the refund endpoint."
- **Stripe customer counts / topup amount distributions.** SQL reads are 100 ms; bake them as Phase 3 admin endpoints, not as live gauges.
- **`process_uptime_seconds` reimplementations.** `prom-client` already includes them.

## Wiring

Same package split as service-registry, adapted for TypeScript: `src/providers/metrics/` (Recorder + impls) + `src/runtime/metrics/` (HTTP listener). Per-provider decorators live next to the provider they wrap. Per the conventions doc, **no service or repo package may import `prom-client` directly** — all emissions go through the `Recorder` interface.

### Package layout

- `src/providers/metrics/recorder.ts` — `Recorder` interface: a fat **domain-specific** surface (e.g. `incRequest(capability, model, tier, outcome)`, `addNodeCostWei(capability, model, nodeId, weiString)`, `observePayerDaemonCall(method, durationSec)`), NOT a generic `counter/gauge/histogram` factory. Adding a metric means adding a method here and implementing it in every Recorder. Also exports label-value constants. Coexists with the existing `MetricsSink` interface from `0011-local-tokenizer-metric.md` — the new Recorder does NOT extend it; instead, both `PrometheusRecorder` and `NoopRecorder` implement BOTH interfaces so legacy `tokenAudit` emits keep working unchanged. Phase 2 unifies them.
- `src/providers/metrics/noop.ts` — `NoopRecorder` class implementing both `Recorder` and `MetricsSink`. Re-exports the legacy `createNoopMetricsSink` factory for back-compat with `main.ts` and `tokenAudit.test.ts`.
- `src/providers/metrics/prometheus.ts` — `prom-client` impl. Owns a custom `Registry` (not the default global) + `collectDefaultMetrics({ register })` for built-in `process_*` / `nodejs_*` collectors. Bucket presets defined inline (`DEFAULT_BUCKETS`, `FAST_BUCKETS`). Dual-histogram for the unix-socket gRPC histogram is two distinct `Histogram` fields written from one `observePayerDaemonCall` call.
- `src/providers/metrics/capVec.ts` — cardinality-cap wrapper around `prom-client`'s `Counter`/`Gauge`/`Histogram` vecs. Drops new label tuples beyond `maxSeriesPerMetric`, fires `onCapExceeded` exactly once per metric. Split out of `prometheus.ts` to stay under the existing 400-line ESLint warn threshold.
- `src/providers/metrics/legacySink.ts` — implements just the legacy `MetricsSink` half of the dual interface. Hard-allowlists only the three legacy `tokens_*` names; anything else is silently dropped. Phase 2 deletes this file.
- `src/providers/metrics/fastify.ts` — small factory for the metrics-listener Fastify instance. Lives under `providers/metrics/` because the bridge's `no-cross-cutting-import` ESLint rule forbids importing `fastify` outside `src/providers/`.
- `src/providers/metrics/testhelpers.ts` — `Counter` test helper class implementing both interfaces.
- `src/runtime/metrics/server.ts` — `createMetricsServer({ listen, recorder, logger })` — wires the Fastify instance from `providers/metrics/fastify.ts` to a `GET /metrics` + `GET /healthz` route, with graceful shutdown via Fastify's `close()`. Returns a no-op when `listen` is empty.

### Decorators (per-provider, NOT centralized)

Each provider directory exports a `metered.ts` (or co-located `withMetrics(...)` factory) that wraps its own client. Production wiring is one wrap line per provider in the composition root.

- `src/providers/payerDaemon/metered.ts` → `livepeer_bridge_payer_daemon_calls_total`, `livepeer_bridge_payer_daemon_call_duration_seconds` + `_fast` (dual-histogram, unix-socket gRPC).
- `src/providers/nodeClient/metered.ts` → `livepeer_bridge_node_requests_total`, `livepeer_bridge_node_request_duration_seconds`. Also emits `livepeer_bridge_node_cost_wei_total` once `CreatePayment` returns the wei amount (the decorator has `(capability, model, node_id)` in scope).
- `src/providers/stripe/metered.ts` → `livepeer_bridge_stripe_api_calls_total`, `livepeer_bridge_stripe_api_call_duration_seconds`. Distinct from `livepeer_bridge_stripe_webhooks_total` (which is webhook-handler timing — direct injection in the webhook route).
- `src/providers/tokenizer/metered.ts` → optional bounded counter; skip in Phase 1.

### Fastify per-route hook (customer-facing surface)

`src/runtime/http/metricsHook.ts` — `onRequest` records start time; `onResponse` emits `livepeer_bridge_requests_total` and `livepeer_bridge_request_duration_seconds`. Capability and model derived from the route + parsed body; tier from the authenticated customer (already on `request.caller`). Single integration covers all customer endpoints.

### Direct Recorder injection

For outcome-by-branch counters and ledger emits where the wrapper can't see context:

- `src/service/auth/rateLimit.ts` — `livepeer_bridge_rate_limit_rejections_total{tier,kind}`.
- `src/service/routing/router.ts` — `livepeer_bridge_node_retries_total{reason,attempt}` (retry decision happens here; the per-attempt request metric comes from the decorated `nodeClient`).
- `src/service/billing/ledger.ts` — `livepeer_bridge_revenue_usd_cents_total{capability,model,tier}` on commit (not on reserve — see the exec plan's Decisions log).
- `src/service/billing/topups.ts` — `livepeer_bridge_topups_total{outcome}` on each state transition.
- `src/runtime/http/stripe/webhook.ts` — `livepeer_bridge_stripe_webhooks_total`, `livepeer_bridge_stripe_webhook_duration_seconds`.
- `src/service/nodes/healthLoop.ts` — `livepeer_bridge_node_circuit_transitions_total`, `livepeer_bridge_node_quote_age_seconds`.
- `src/service/tokenAudit/index.ts::emitDrift` — appends `livepeer_bridge_token_drift_percent`, `livepeer_bridge_token_count_local_total`, `livepeer_bridge_token_count_reported_total` next to the existing legacy emits.

### Periodic sampler

`src/service/metrics/sampler.ts` — runs every 30 s. Owns:

- `SELECT count(*), MIN(EXTRACT(EPOCH FROM NOW() - created_at))::int FROM reservation WHERE state='open'` → `livepeer_bridge_reservations_open`, `livepeer_bridge_reservation_open_oldest_seconds`.
- In-memory NodeBook → four `livepeer_bridge_nodes_state{state}` count gauges.
- The existing PayerDaemon health loop already calls `GetDepositInfo` every 10 s — sampler reads its cached result and exposes `livepeer_bridge_payer_daemon_deposit_wei`, `livepeer_bridge_payer_daemon_reserve_wei`. No new RPC.

### Composition

The composition root (`src/runtime/server.ts` or wherever production wiring lives) is the only place that constructs the prom impl. When `METRICS_LISTEN` is set: build the Recorder, start the metrics Fastify instance, wrap each provider with its `metered.ts`. Otherwise pass the noop Recorder (default) and skip the metrics server. Tests keep the noop unchanged.

The existing `MetricsSink` interface from `0011-local-tokenizer-metric.md` is preserved as a separate, narrower surface — the new `Recorder` does NOT extend it; both impls satisfy both interfaces side-by-side. No service code that already takes a `MetricsSink` needs to change. Phase 2 migrates `tokenAudit` onto the prefixed names emitted via the Recorder and deletes `legacySink.ts`.
