# Grafana dashboard

Pre-built dashboard covering everything `livepeer-openai-gateway` emits to Prometheus, plus a top-row that joins bridge metrics against `livepeer-payment-library` daemon metrics and `livepeer-byoc` worker metrics for cross-repo reconciliation. Mirrors the metric catalog in [`docs/design-docs/metrics.md`](../../design-docs/metrics.md).

## Files

- [`livepeer-openai-bridge.json`](livepeer-openai-bridge.json) — dashboard definition (Grafana 10.0+, schema 39).

## Import

### UI (one-shot)

1. Grafana → **Dashboards → Import**.
2. Upload `livepeer-openai-bridge.json` (or paste the contents).
3. When prompted, pick the Prometheus datasource that scrapes the bridge's `METRICS_LISTEN` endpoint (default `:9602`). For the cross-repo reconciliation row to populate, the same Prometheus must also scrape the payer-daemon and worker `/metrics`.
4. Click **Import**. The dashboard's `uid` is `livepeer-openai-bridge` — re-imports update in place.

### API (CI / GitOps)

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -d @<(jq '{dashboard: ., overwrite: true}' docs/operations/grafana/livepeer-openai-bridge.json) \
  https://grafana.example.com/api/dashboards/db
```

### Provisioning (file-based)

Drop the JSON into your provisioned-dashboards folder, e.g. `/etc/grafana/provisioning/dashboards/livepeer/`, alongside a `dashboards.yaml`:

```yaml
apiVersion: 1
providers:
  - name: livepeer
    orgId: 1
    folder: Livepeer
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards/livepeer
```

## Layout

10 rows, top-to-bottom in order of operational importance:

| Row | What it shows |
|---|---|
| **Cross-repo reconciliation** | Gross margin %, revenue cents/min by tier, node cost wei/min, worker units served vs bridge revenue, daemon-side gRPC p99 vs bridge-side PayerDaemon p99. Joins three repos. |
| **Overview** | Build version, build_info heartbeat, qps, customer-visible error rate (gauge), healthy nodes count, oldest pending top-up age (Phase 2 placeholder). |
| **Customer requests** | qps by capability + tier + outcome, p99 latency by capability + tier, retries by attempt + reason. |
| **Money & ledger** | Revenue cents/min by tier and by capability, top-ups by outcome, open reservations, oldest open reservation age (LEDGER LEAK CANARY). |
| **Stripe webhook** | Webhooks by event_type + outcome, webhook handler p99. |
| **Node pool** | Nodes by state (4 colored stat tiles), per-node success rate, per-node p99 latency, quote age per node + capability, circuit transitions. |
| **PayerDaemon (unix-socket fast path)** | Calls by method + outcome, p99 from fast histogram, deposit and reserve gauges. |
| **Token audit** | Drift % p50/p95/p99 by direction, top drifters table. |
| **Rate limits** | Rejections by tier + kind (stacked). |
| **Process + Node runtime** (collapsed by default) | Heap, event-loop lag p99, GC, open FDs. |

## Cross-repo reconciliation row

This is the row most operators won't have anywhere else. The bridge is the only place USD, customer identity, and node identity all meet, so it's also the only place these joins can live without dragging customer IDs into other services.

The row expects all three services (`livepeer-openai-gateway`, `livepeer-payment-library`'s daemon, `livepeer-byoc`'s worker) to be scraped by the same Prometheus. Cross-environment scrapes also work as long as the metric names line up.

| Panel | What it answers | What to do when it diverges |
|---|---|---|
| **Gross margin %** | Are customers paying more than nodes cost us? | Sustained < 20% means the rate-card is under-pricing. Reprice via the rate-card config; check whether one capability dominates the loss. The threshold in this panel is 20% (red) / 35% (green); tune to your business target. |
| **Revenue cents/min by tier** | Which tier is generating the most revenue right now? | Use as context — alongside the cost panel it explains which tiers are profitable. If `free` tier shows non-zero revenue, that's a billing bug. |
| **Node cost wei/min** | What are we paying nodes per minute? | Sudden spikes without matching revenue = a node returned an unexpectedly large quote, or the rate-card on the worker side widened. Cross-check with row 6's per-node panels. |
| **Worker units served vs Bridge revenue** | Do worker-reported units match bridge billing? | Persistent gap = tokenizer drift (already covered by `livepeer_bridge_token_drift_percent` in row 8) OR billing bug. The panel currently plots revenue cents directly; a true 'units billed' line requires a recording rule that divides revenue by the rate-card per `(capability, model)` — see the customizing section. |
| **Daemon p99 vs Bridge p99 (CreatePayment)** | What's the unix-socket overhead between daemon and bridge? | A widening gap between server-side and client-side p99 means the unix socket is slow — usually kernel-side queueing under heavy fork load, or an unrelated CPU hog. Both quantiles use the **fast** histogram so sub-ms detail survives. |

If a panel here goes red, jump to the corresponding non-reconciliation row first (rows 4 / 6 / 7 / 8) for breakdowns.

## Variables

The dashboard exposes four template variables at the top:

| Variable | Source | What it does |
|---|---|---|
| `datasource` | Prometheus picker | Switch dashboards across datasources without editing JSON. |
| `job` | `label_values(livepeer_bridge_build_info, job)` | Filter to a specific Prometheus scrape job (default: All). |
| `instance` | `label_values(...{job=~"$job"}, instance)` | Filter to a specific bridge instance (default: All). |
| `eth_usd_cents` | Custom (default `400000` = $4000/ETH × 100) | Used by the gross margin panel to convert wei to USD cents. Override per environment. |

Every bridge-side panel filters by `{job=~"$job"}`. The cross-repo panels intentionally do NOT filter on `$job` for the daemon/worker queries — `$job` in this dashboard refers to the bridge's scrape job, and adding it to `livepeer_payment_*` / `livepeer_worker_*` queries would silently zero them. If you run multiple bridge fleets and want per-fleet reconciliation, extend the daemon/worker scrape configs to include a matching job label and edit the queries by hand.

### Pinning `eth_usd_cents` to a real oracle

The default is a hard-coded constant — fine for a sanity check, wrong for accounting. Replace it with a recording rule that scrapes a price feed (e.g. a Coingecko exporter or your own oracle):

```yaml
groups:
  - name: livepeer_bridge_oracles
    interval: 60s
    rules:
      - record: livepeer_bridge_eth_usd_cents
        expr: round(coingecko_price_usd{symbol="ETH"} * 100)
```

Then change the `eth_usd_cents` variable's `query` from the constant to `query_result(livepeer_bridge_eth_usd_cents)` and switch its `type` from `custom` to `query`.

## Customizing

**Adjust thresholds.** The threshold-driven panels are:

- *Gross margin %* — red < 20%, yellow 20–35%, green ≥ 35%. Edit per business target.
- *Customer-visible error rate* — green/yellow/red at `0`, `0.01`, `0.05` (1%, 5%). Edit per SLO.
- *Open reservations* — green/yellow/red at `0`, `5`, `10`.
- *Oldest open reservation age* — green/yellow/red at `0`, `60s`, `300s`. **This is the ledger-leak canary.** Set this alert before anything else.
- *Quote age per node + capability* — table cell colors trigger at `60s` (yellow) and `120s` (red).

**Build the units-billed recording rule.** The "Worker units served vs Bridge revenue" panel currently plots revenue directly. To get a true unit-for-unit comparison, add a recording rule per (capability, model) that divides revenue by the rate-card:

```yaml
- record: livepeer_bridge_units_billed_per_sec
  expr: |
    sum by (capability, model) (rate(livepeer_bridge_revenue_usd_cents_total[5m]))
      / on (capability, model) group_left
    livepeer_bridge_rate_card_cents_per_unit
```

…then add `livepeer_bridge_rate_card_cents_per_unit` (a static gauge) to the bridge metrics surface. Until both land, treat the panel as a directional comparison only.

**Add panels.** Every metric in [`docs/design-docs/metrics.md`](../../design-docs/metrics.md) has stable label values; copy any panel and tweak the PromQL.

**Drop panels.** If you don't run Stripe (e.g. invoice-only tier), the row 5 panels just show "No data". Either delete them or filter to your specific deployment via the `job` variable.

## Pairing with alerts

The dashboard displays metrics; it does NOT ship alert rules. A starter `groups:` block to pair with:

- `livepeer_bridge_reservation_open_oldest_seconds > 300` for 2 min — **ledger leak**.
- `livepeer_bridge_nodes_state{state="healthy"} == 0` for 30 s — **no servable capacity**.
- `(rate of 4xx/402/429/5xx) / (rate of all) > 0.05` for 5 min — **customer-visible degradation**.
- `histogram_quantile(0.99, ...request_duration...) > 30` for 5 min — **p99 SLO breach**.
- Margin panel < 20% for 1 h — **rate-card review**.

## Compatibility

- Grafana 10.0+ (uses `schemaVersion: 39`, `timeseries` panel type).
- Prometheus 2.x or compatible (Mimir / Cortex / Thanos via `prometheus` datasource plugin).
- Bridge version that ships the `livepeer_bridge_*` namespace (Phase 1 of the metrics catalog).
- For the cross-repo row: payer-daemon and worker must emit `livepeer_payment_*` / `livepeer_worker_*` to the same Prometheus.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Panels show "No data" | The bridge isn't started with `METRICS_LISTEN`, or Prometheus isn't scraping `:9602`. Check `/metrics` directly with curl. |
| `Build version` stat shows nothing | The bridge wasn't built with `setBuildInfo()` wired (the constant-1 gauge at startup). |
| Cross-repo row entirely empty | Prometheus is scraping the bridge but not the daemon or worker. Add the daemon's `:9601` and worker's `/metrics` endpoints to your scrape config. |
| Cross-repo row partial — bridge panels work, daemon/worker do not | Daemon/worker metrics are scraped but their job labels don't match `livepeer_payment_*` / `livepeer_worker_*` filters. The cross-repo queries deliberately don't filter by `$job` so this is normally fine; check metric names match the catalog. |
| Gross margin shows nonsense (huge negative or positive) | `$eth_usd_cents` is wrong, or you're seeing a startup window where one counter has data and the other hasn't ticked yet. Wait one full scrape interval. |
| Oldest reservation age stuck at 0 | Sampler hasn't run yet (30s cycle), or no reservations exist. Place a paid request and wait. |
| Quote age table empty | No quotes have been refreshed yet. The gauge is set on every quote refresh — if no requests have flowed, no rows. |
