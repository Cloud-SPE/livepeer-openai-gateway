---
id: 0021
slug: metrics-phase-1
title: Metrics Phase 1 — prom-client Recorder, /metrics listener, request + money + node + payer-daemon instrumentation
status: completed
owner: agent
opened: 2026-04-25
started: 2026-04-25
completed: 2026-04-25
---

## Goal

Wire a `prom-client`-backed Recorder behind the existing `MetricsSink` interface (introduced in [`0011-local-tokenizer-metric.md`](../completed/0011-local-tokenizer-metric.md)), expose it on a separate Fastify listener via `METRICS_LISTEN`, and instrument the request path / billing / node selection / PayerDaemon client / Stripe webhook with the Phase 1 catalog from [`docs/design-docs/metrics.md`](../../design-docs/metrics.md). Mirrors the verified pattern in [`livepeer-service-registry`](../../../../livepeer-service-registry/docs/design-docs/observability.md) wholesale, adapted for TypeScript / Fastify.

This is the bridge-side third of the cross-repo metrics rollout. Pairs with [`livepeer-payment-library/docs/exec-plans/0019-metrics-phase-1.md`](../../../../livepeer-payment-library/docs/exec-plans/0019-metrics-phase-1.md) and [`openai-worker-node/docs/exec-plans/active/0008-metrics-phase-1.md`](../../../../openai-worker-node/docs/exec-plans/active/0008-metrics-phase-1.md). Consistent label keys (`capability`, `model`, `tier`, `node_id`, `unit`) across all three is what makes the four reconciliation panels in `metrics.md` Cross-repo reconciliation work.

Authoritative cross-repo conventions: [`../../../../livepeer-modules-conventions/metrics-conventions.md`](../../../../livepeer-modules-conventions/metrics-conventions.md).

Advances [`operator-economics-metrics-tooling`](../tech-debt-tracker.md#operator-economics-metrics-tooling) (HIGH severity) — closes item 4 (Prometheus endpoint) and lays the data foundation for items 1–3 (Phase 3 SQL rollups).

## Non-goals

- No streaming TTFT / partial-stream / drift-violation counters (Phase 2).
- No `livepeer_bridge_customer_balance_usd_cents` distribution histogram (Phase 2; needs the periodic SQL sweep job).
- No `GET /admin/metrics/{daily,per-worker,per-tier,request/:work_id}` endpoints (Phase 3 — items 1–3 + 6 of `operator-economics-metrics-tooling`). SQL-backed; don't depend on Phase 1 metrics.
- No deletion of the existing unprefixed `tokens_drift_percent` / `tokens_local_count` / `tokens_reported_count`. Emitted in parallel with the prefixed versions in Phase 1; Phase 2 deletes after one release cycle.
- No auth on `/metrics`. Reverse-proxy or bind to localhost only.

## Approach

Package layout follows service-registry, adapted for TypeScript: `src/providers/metrics/` (Recorder + impls) + `src/runtime/metrics/` (HTTP listener). Per-provider decorators live next to the provider they wrap. Per the conventions doc, **no service or repo package may import `prom-client` directly** — emissions go through the Recorder/Sink interface.

### Provider package

- [x] `src/providers/metrics/recorder.ts` — `Recorder` interface (extends the existing `MetricsSink`); `Counter`, `Gauge`, `Histogram` factories.
- [x] `src/providers/metrics/cardinality.ts` — `Map<string, Set<string>>`-backed wrapper that drops new label tuples beyond `METRICS_MAX_SERIES_PER_METRIC` (default `10000`, `0` = disabled). One WARN per (metric, ~1-min violation block) gated by a `Math.floor(Date.now()/60000)` stamp.
- [x] `src/providers/metrics/buckets.ts` — `DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`; `FAST_BUCKETS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1]`. Plus a `registerDualHistogram(name, help, labels)` helper that constructs both `<name>_seconds` (Default) and `<name>_seconds_fast` (Fast) and returns an Observer that writes to both.
- [x] `src/providers/metrics/names.ts` — exported metric-name constants for direct-injection sites and decorators.
- [x] `src/providers/metrics/noop.ts` — default for tests + endpoint-off mode (replaces `src/providers/metrics/noop.ts`'s existing minimal impl with the broader Recorder shape).
- [x] `src/providers/metrics/prometheus.ts` — `prom-client` impl with custom `Registry` + `collectDefaultMetrics({ register })` for built-in `process_*` / `nodejs_*` collectors.

### Runtime package (HTTP listener)

- [x] `src/runtime/metrics/server.ts` — separate Fastify instance (NOT the customer-facing one). Listens on `METRICS_LISTEN` env (e.g. `127.0.0.1:9602`). Single route: `GET /metrics` returning `register.contentType` + `register.metrics()`. Graceful shutdown via the existing lifecycle hook.
- [x] **Env config** in `src/config/env.ts`: add `METRICS_LISTEN` (string, default empty = OFF) and `METRICS_MAX_SERIES_PER_METRIC` (int, default `10000`). Document in `.env.example`.
- [x] **`.env.example`**: `METRICS_LISTEN=127.0.0.1:9602` (commented, port `:9602` per [`port-allocation.md`](../../../../livepeer-modules-conventions/port-allocation.md)). Comment block explains: bind `127.0.0.1` or internal-LAN — never the public interface.

### Per-provider decorators

Each provider directory owns a `metered.ts` (or co-located `withMetrics(...)` factory) that wraps its own client. Production wiring is one wrap per provider in the composition root.

- [x] `src/providers/payerDaemon/metered.ts` → `livepeer_bridge_payer_daemon_calls_total{method,outcome}` (counter), `livepeer_bridge_payer_daemon_call_duration_seconds{method}` (Default buckets), `livepeer_bridge_payer_daemon_call_duration_seconds_fast{method}` (Fast buckets) — dual-histogram via `registerDualHistogram` since unix-socket gRPC. `method` ∈ {`StartSession`, `CreatePayment`, `CloseSession`, `GetDepositInfo`}.
- [x] `livepeer_bridge_node_cost_wei_total{capability,model,node_id}` is emitted from inside `payerDaemon/metered.ts` when `CreatePayment` returns the wei amount. The decorator has the call-site context (`capability` + `model` + `node_id` are in scope); putting the emit anywhere else would force re-plumbing those values.
- [x] `src/providers/nodeClient/metered.ts` → `livepeer_bridge_node_requests_total{node_id,outcome}`, `livepeer_bridge_node_request_duration_seconds{node_id,outcome}` (Default buckets — over-the-wire HTTP).
- [x] `src/providers/stripe/metered.ts` → `livepeer_bridge_stripe_api_calls_total{op,outcome}`, `livepeer_bridge_stripe_api_call_duration_seconds{op}`. (Distinct from `livepeer_bridge_stripe_webhooks_total` — that's webhook handler timing, this is outbound Stripe SDK calls.)

### Fastify per-route hook (customer-facing surface)

- [x] `src/runtime/http/metricsHook.ts` — `onRequest` records start time; `onResponse` emits `livepeer_bridge_requests_total{capability,model,tier,outcome}` and `livepeer_bridge_request_duration_seconds{capability,model,tier,outcome}` (Default buckets). Capability and model derived from the route + parsed body; tier from the authenticated customer (already on `request.caller`). Single integration covers all customer endpoints.

### Direct Recorder injection

- [x] `src/service/auth/rateLimit.ts` — `livepeer_bridge_rate_limit_rejections_total{tier,kind}`.
- [x] `src/service/routing/router.ts` — `livepeer_bridge_node_retries_total{reason,attempt}` (the retry decision happens here; per-attempt request metric comes from the decorated `nodeClient`).
- [x] `src/service/billing/ledger.ts` — `livepeer_bridge_revenue_usd_cents_total{capability,model,tier}` on commit. (Not on reserve — see Decisions log.)
- [x] `src/service/billing/topups.ts` — `livepeer_bridge_topups_total{outcome}` on each state transition (`initiated`, `succeeded`, `failed`, `disputed`, `refunded`).
- [x] `src/runtime/http/stripe/webhook.ts` — `livepeer_bridge_stripe_webhooks_total{event_type,outcome}`, `livepeer_bridge_stripe_webhook_duration_seconds{event_type}`.
- [x] `src/service/nodes/healthLoop.ts` — `livepeer_bridge_node_circuit_transitions_total{node_id,to_state}` on each circuit state change; `livepeer_bridge_node_quote_age_seconds{node_id,capability}` gauge updated on each successful `/quotes` poll.
- [x] `src/service/tokenAudit/index.ts::emitDrift` — append `livepeer_bridge_token_drift_percent` (histogram), `livepeer_bridge_token_count_local_total` (counter, replacing the gauge), `livepeer_bridge_token_count_reported_total` (counter) emits next to the existing legacy unprefixed names. Both emitted in parallel for one release.

### Periodic sampler

- [x] `src/service/metrics/sampler.ts` — runs every 30 s. Owns:
  - `SELECT count(*), MIN(EXTRACT(EPOCH FROM NOW() - created_at))::int FROM reservation WHERE state='open'` → `livepeer_bridge_reservations_open`, `livepeer_bridge_reservation_open_oldest_seconds`.
  - In-memory NodeBook → four `livepeer_bridge_nodes_state{state}` count gauges.
  - The existing PayerDaemon health loop already calls `GetDepositInfo` every 10 s — sampler reads its cached result and exposes `livepeer_bridge_payer_daemon_deposit_wei`, `livepeer_bridge_payer_daemon_reserve_wei`. No new RPC.

### Build info

- [x] `livepeer_bridge_build_info` gauge=1 with labels `version` (from `package.json`), `node_env`, `node_version`. Set once at server construction.

### Composition root

- [x] `src/runtime/server.ts` (or wherever production wiring lives) — when `METRICS_LISTEN` is set: build the prom Recorder, start the metrics Fastify instance, wrap each provider with its `metered.ts`. Otherwise pass the noop Recorder (default) and skip the metrics server. Tests keep the noop unchanged.

The existing `MetricsSink` interface from [`0011`](../completed/0011-local-tokenizer-metric.md) is preserved; the new `Recorder` extends it. No service code that already takes a `MetricsSink` needs to change.

### Tests

- [x] Unit: cardinality wrapper drops at threshold + emits exactly one WARN per block (fake `Date.now()`).
- [x] Unit: prom impl (custom registry, `FAST_BUCKETS` and `DEFAULT_BUCKETS` correctly applied; `registerDualHistogram` wires both observers).
- [x] Unit: each `metered.ts` decorator (table-driven, one row per method × outcome).
- [x] Integration (TestPg + mock PayerDaemon): one happy-path chat request emits `livepeer_bridge_requests_total`, `livepeer_bridge_request_duration_seconds`, `livepeer_bridge_payer_daemon_calls_total{method=CreatePayment}` + BOTH histograms (`_seconds` and `_seconds_fast`), `livepeer_bridge_node_requests_total`, `livepeer_bridge_node_cost_wei_total`, `livepeer_bridge_revenue_usd_cents_total`. One rate-limited request emits `livepeer_bridge_rate_limit_rejections_total`. One upstream-5xx run emits `livepeer_bridge_node_retries_total{attempt=2}` and `livepeer_bridge_requests_total{outcome=5xx}` only after retry exhaustion.
- [x] Sampler unit test — stubbed DB + NodeBook → gauges update.
- [x] End-to-end: bring up bridge with `METRICS_LISTEN=127.0.0.1:0`, drive one customer request, assert `GET /metrics` returns 200 + contains `livepeer_bridge_build_info` + a non-zero `livepeer_bridge_requests_total` and `livepeer_bridge_revenue_usd_cents_total`.

### Docs + tracker

- [x] `docs/operations/deployment.md` — `METRICS_LISTEN` and `METRICS_MAX_SERIES_PER_METRIC` env entries; new "Observability" subsection. Sample Prometheus scrape config. Bind-host warning. Link to the conventions doc.
- [x] `docs/design-docs/architecture.md` — add `src/providers/metrics/` and `src/runtime/metrics/` to the package layout.
- [x] `docs/design-docs/token-audit.md` — append the `livepeer_bridge_token_drift_percent` rename + one-release deprecation note.
- [x] Mark item 4 of [`operator-economics-metrics-tooling`](../tech-debt-tracker.md#operator-economics-metrics-tooling) resolved with a pointer to this plan; items 1–3 + 5–7 stay open with a `Phase 3` note.
- [x] Open a new low-severity entry `tokens-drift-unprefixed-names-removal` pointing at Phase 2 cleanup.

## Decisions log

### 2026-04-25 — Mirror service-registry's verified pattern wholesale

Same call as the daemon's 0019 and worker's 0008. service-registry has shipped this exact shape at `status: verified` (adapted for TS where needed). Same package split, same env name (`METRICS_LISTEN`), same dual-histogram pattern, same cardinality cap default. Rule of three: 1 verified + 2 anticipated copies doesn't trigger Go code extraction yet — and the bridge is TS anyway, so it would never share with the Go fleet at the code level.

### 2026-04-25 — Provider/runtime package split

Recorder is a provider; listener is runtime. Two layers, two responsibilities. Earlier draft of this plan combined them into one `src/runtime/metrics/`; corrected to mirror service-registry's split.

### 2026-04-25 — Per-provider `metered.ts`, NOT centralized decorators

`src/providers/payerDaemon/metered.ts`, `src/providers/nodeClient/metered.ts`, `src/providers/stripe/metered.ts`. Adding a method to the payerDaemon client = update `metered.ts` in the same directory. Matches service-registry's per-provider `metered.go` pattern.

### 2026-04-25 — Per-domain decorators with `method`/`op` labels

Bounded label per provider, distinct metric names per domain. `livepeer_bridge_payer_daemon_*` for unix-socket gRPC, `livepeer_bridge_node_*` for over-the-wire upstream HTTP, `livepeer_bridge_stripe_api_*` for outbound Stripe SDK. Each is a separate dashboard section.

### 2026-04-25 — Dual-histogram for `livepeer_bridge_payer_daemon_call_duration_seconds`

Same `Observe()` writes to both `_seconds` (Default) and `_seconds_fast` (Fast). Matches the conventions doc's gRPC pattern. PayerDaemon RPC is unix-socket-only (sub-ms typical) but consistency with the fleet wins; cost is 2× histogram series for one specific metric.

### 2026-04-25 — `livepeer_bridge_node_cost_wei_total` emitted from inside `payerDaemon/metered.ts`

The wei amount is what `CreatePayment` returns; the call-site context (capability + model + node_id) is in scope inside the decorator. Putting the emit elsewhere forces re-plumbing those values. The metric is logically a property of the PayerDaemon call.

### 2026-04-25 — Separate Fastify instance for `/metrics`

Customer Fastify has rate-limit middleware, body-size limits, JSON content-type negotiation, and is exposed publicly. Adding `/metrics` there either accidentally exposes it (forgot reverse-proxy rule) or requires special-casing every middleware. Second instance on a separate port = one constructor call; operator binds to whatever interface they want.

### 2026-04-25 — Cardinality cap as a wrapper

Same as daemon and worker (and service-registry): `Map<string, Set<string>>`-backed wrapper, default 10000, per-block WARN gate. `prom-client` doesn't enforce per-metric limits; this catches slipped high-cardinality labels (e.g., a slipped `customer_id`).

### 2026-04-25 — Sampler runs every 30 s, not on-event

`livepeer_bridge_reservations_open` and `livepeer_bridge_node_quote_age_seconds` are gauges that only need to be ~accurate. Updating on every reservation event would 10×–100× metric write rate for no operational gain. 30 s matches the existing NodeBook health-poll cadence.

### 2026-04-25 — `livepeer_bridge_*` prefix (not `bridge_*`)

Earlier draft used `bridge_*` for compactness. Switched to `livepeer_bridge_*` for fleet consistency — matches `livepeer_registry_*`, `livepeer_payment_*`, `livepeer_worker_*`. A single Grafana datasource scraping all four services uses `livepeer_*` as the umbrella.

### 2026-04-25 — Emit both `tokens_drift_percent` and `livepeer_bridge_token_drift_percent` for one release

Existing dashboards (if any) reference the unprefixed name. Phase 1 emits both, Phase 2 deletes the unprefixed. One release of overlap is enough — the metric is observe-only today, no automated systems consume it.

### 2026-04-25 — `livepeer_bridge_revenue_usd_cents_total` on commit, not on reserve

A reservation can be partially refunded if actual cost < estimate. Emitting at commit gives true revenue (already net of refund). Reserving-then-refunding-the-delta double-counts unless we emit on commit only.

### 2026-04-25 — `outcome` granularity stays coarse for Phase 1

`{2xx, 4xx, 402, 429, 5xx}` is enough to dashboard "is the bridge serving customers" without root-cause classification. Phase 2 splits 5xx if a real "which kind of 5xx is dominating" question shows up.

### 2026-04-25 — `node_id` label uses the `id` from `nodes.yaml`, not URL or eth address

YAML `id` is operator-chosen, stable, bounded. URL changes when DNS rotates; eth address is also bounded but less mnemonic. Stable mnemonic IDs make dashboards readable.

## Open questions

- **`tier` label cardinality**: `{free, starter, standard, pro, premium}` + a sentinel `unknown`. Six values × ~10 capabilities × ~30 models = ~1800 series — well under the 10k cap.
- **Partial-stream revenue inclusion**: yes — a partial stream that emits a usage chunk commits the partial and the metric reflects it. A failed-with-no-tokens-served stream refunds and doesn't emit (zero contribution). Documented in [`streaming-semantics.md`](../../design-docs/streaming-semantics.md)'s settlement table.

## Artifacts produced

Commits (oldest → newest):

- `ba076e7` — `metrics: scaffold Phase 1 — Recorder + Fastify metrics listener` — provider package, separate Fastify listener, noop, prom impl, cardinality cap (split across `prometheus.ts` + `capVec.ts` + `legacySink.ts` for ESLint line-length compliance), dual-interface coexistence with the existing `MetricsSink`.
- `6e04b58` — `docs: metrics — reconcile Wiring section to domain-specific Recorder` — design doc reconciliation.
- `2308108` — `metrics: Pass A — provider withMetrics, Fastify hook, periodic sampler` — payerDaemon / nodeClient / stripe `metered.ts`; `metricsHook.ts`; `sampler.ts`.
- `1c8426d` — `metrics: Pass B — activate Phase 1 scrape surface` — env, composition root, `CreatePaymentInput` plumbed with `(capability, model, nodeId)`, `NodeBook.findIdByUrl`, hook registration, sampler start, direct-injection sites in rateLimit / retry / billing / Stripe webhook / quoteRefresher / tokenAudit.
- `4bd7bf9` — `metrics: Grafana dashboard for the bridge + cross-repo reconciliation` — 37 panels in 10 rows including the cross-repo reconciliation row + README.

Closes item 4 of [`operator-economics-metrics-tooling`](../tech-debt-tracker.md#operator-economics-metrics-tooling) (Prometheus endpoint). Items 1–3 + 5–7 remain open as Phase 3 (SQL-backed `/admin/metrics/*` rollups + static dashboard). New low-severity entry [`tokens-drift-unprefixed-names-removal`](../tech-debt-tracker.md#tokens-drift-unprefixed-names-removal) tracks the Phase 2 cleanup of the legacy `MetricsSink` parallel emits.
