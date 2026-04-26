---
title: Operator admin console
status: accepted
last-reviewed: 2026-04-26
---

# Operator admin console

Operator-facing web app served at `/admin/console/*`. Authenticated by `X-Admin-Token` (existing) plus an optional `X-Admin-Actor` operator handle (new — see [`admin-endpoints.md`](./admin-endpoints.md)). Built from `bridge-ui/admin/`; consumes `/admin/*` JSON.

This spec is the canonical UX contract for the console. For the JSON surface it consumes, see [`admin-endpoints.md`](./admin-endpoints.md). For the build/runtime stack (Lit + RxJS + modern CSS, light DOM, npm workspaces), see [`ui-architecture.md`](../design-docs/ui-architecture.md).

## Audience and access model

- A single shared `ADMIN_TOKEN`. Per-operator tokens + RBAC are Phase 2.
- Operators identify themselves at sign-in via a free-text handle (`alice`, `bob.k`, validated `^[a-z0-9._-]{1,64}$`). The handle is **not** auth — anyone with the token can claim any handle. It is **attribution**: the audit log shows handles instead of opaque token-hashes.
- Auth: paste token + handle → validated by `GET /admin/health` → stored under `sessionStorage["bridge.admin.session"]`. Tab-scoped — closing the tab signs out.
- All requests carry `X-Admin-Token` and `X-Admin-Actor`. A 401 from any endpoint clears the session.

## Display rules

- USD: dollars-and-cents (`$12.34`). Negative for refund-driven corrections.
- Tokens / counts: locale grouping.
- Status badges: `healthy` / `active` = success-tint; `degraded` / `suspended` = warning-tint; `circuit_broken` / `closed` / `failed` = danger-tint.
- Customer ID and Stripe session strings: monospace, truncated with `…`. Copy-on-click is deferred.
- Color follows OS preference via `color-scheme: light dark`. No in-app toggle.
- Action buttons that change visible state (refund, suspend) are styled `danger` red. Restore-service actions (unsuspend) use the primary accent.

## Pages

App shell: top bar (brand · `admin` scope pill · nav · operator-handle pill + sign-out) + routed `<main>`. Hash routing with View Transitions on swap.

### `/admin/console/` — sign-in

Two inputs: admin token (`type="password"`) and operator handle (`type="text"`, `pattern="^[a-z0-9._-]{1,64}$"`). Submit calls `signIn(token, actor)` which validates against `GET /admin/health` and stores `{ token, actor }` on success. Malformed handles surface client-side `actor must match ^[a-z0-9._-]{1,64}$` before any HTTP call. Server errors render in a danger-tinted block.

### `#health`

Top: 4 status tiles (PayerDaemon, Database, Redis, Nodes `<healthy>/<total>`). `:has([data-status='down'])` flips the tile container to danger-tint; `[data-status='warn']` to warning-tint.

Below: an embedded Grafana iframe pointed at `window.GRAFANA_DASHBOARD_URL`. The bridge does not inject this value — operators wire it on the served `index.html` (build-time env or bootstrap script). Unset → the panel collapses to "Configure `window.GRAFANA_DASHBOARD_URL` to embed the Grafana dashboard here." See [`deployment.md`](../operations/deployment.md#operator-admin--grafana-embedding) for the three deployment options.

The console **does not re-render the metrics in-app.** Grafana is the canonical view.

### `#nodes`

Table sorted by `circuit-broken → degraded → healthy` so operators see problems first. Columns: ID (link to detail), URL (mono), Status badge, Tier allowed, Enabled, Weight. Container query collapses to a card list under 720px.

### `#nodes/<id>`

Single-node detail. Top card: URL, status badge, enabled, tier allowed, supported models, weight, consecutive failures, last success / failure / circuit-opened timestamps. Below: chronological event timeline (newest first) sourced from `GET /admin/nodes/:id/events`. Each row shows formatted timestamp + event kind (`circuit_opened` / `circuit_half_opened` / `circuit_closed` / `config_reloaded` / `eth_address_changed_rejected`) + optional `detail`. **No state-changing actions in v1** — operators edit `nodes.yaml` and reload.

### `#customers`

Search box (debounced 300ms) → `GET /admin/customers?q=...&limit=50`. Empty input shows the most recent 50 customers. Result table: Email (link to detail), Tier, Status badge, Balance (cents → USD), Joined date.

### `#customers/<id>`

Detail page with three sections:

**Account panel** — id (mono), tier, status badge, balance, reserved, rate-limit tier, joined.

**Actions row** — context-aware:

- `Suspend` (active customer only) — type-to-confirm dialog. **Required text: the customer's email.** Confirm button stays disabled until input matches exactly. Background marked `danger`.
- `Unsuspend` (suspended customer only) — single-click confirm dialog (no type-to-confirm — restoring service is not a destructive operation).
- `Refund last top-up` — only renders when the customer has a `succeeded` topup. Type-to-confirm with the customer's email; the action targets the Stripe session id of the most-recent succeeded topup. Calls `POST /admin/customers/:id/refund` with `{ stripeSessionId, reason }` (reason defaults to `operator-issued refund`).
- `Issue API key` — opens a labeled-input dialog. On submit, posts to `/admin/customers/:id/api-keys`. The cleartext is shown **exactly once** in a success-tinted banner inserted at the top of the page (same pattern as the customer portal's create-key flow).

**Recent top-ups** — last few topup rows with badge-colored status.

### `#reservations`

Open reservations only, oldest-first with `age_seconds` rendered (`125s` → `2m 5s`, `> 1h` → `1h 23m`). The page on-call hits when `livepeer_bridge_reservation_open_oldest_seconds` alerts.

Read-only. Copy: "Read-only investigation view. Stuck reservations are a symptom; fix upstream (PayerDaemon, node health) and let reconciliation close them."

### `#topups`

Cross-customer top-up search. Customer-id input (debounced 300ms; UUID validated) and status `<select>` (`pending|succeeded|failed|refunded`). Clear-filters button. Result table: When, Customer (truncated), Amount, Status badge, Stripe session (truncated, mono).

### `#audit`

Audit feed with two debounced inputs: actor (exact match) and action (substring). Clear button. Result table: When, Actor (mono), Action (mono), Target (truncated), Status code (colored by 2xx/4xx/5xx category).

**CSV export** — header button generates a CSV from the currently-rendered events client-side and triggers a download. Header columns: `occurred_at, actor, action, target_id, status_code`. Quoting via standard escape-on-comma/quote/newline.

### `#config`

Read-only `nodes.yaml` view from `GET /admin/config/nodes`. Top card: path, sha256 (full 64 hex), modified time, size. Below: loaded-nodes table + raw-yaml `<pre>` block (whitespace-preserved). A `Reload` button re-fetches.

Editing `nodes.yaml` from the UI is **out of scope in v1** — operators edit on disk and `kubectl apply` / `docker compose up -d`. The QuoteRefresher hot-reloads.

## Confirmation rules

| Action      | Guard                | Reasoning                                                                                  |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------ |
| Refund      | Type-to-confirm email | Visible to the customer (Stripe-side refund needed separately); fat-finger has cost.       |
| Suspend     | Type-to-confirm email | Halts API access immediately; fat-finger has cost.                                          |
| Unsuspend   | Single-click confirm | Restores service; the worst case is restoring an account someone wanted re-suspended.       |
| Issue key   | Single-click submit  | Does not affect existing keys; cleartext returned once, customer can revoke if unwanted.    |
| (no action) | `nodes/<id>` detail  | All v1 node mutations happen via `nodes.yaml` on disk.                                      |

## Polling

The admin services do **not** auto-poll in v1. Each page fetches once on mount; actions trigger a re-fetch. A future enhancement: polling on `health$`, `nodes$`, `reservations$` paused on `document.visibilitychange` to "hidden" (so background tabs don't quietly hammer the bridge). Out of scope here.

## Out of scope (v1)

- Multi-operator RBAC.
- "Edit `nodes.yaml`" UI (read-only `GET /admin/config/nodes` only).
- Manually closing stuck reservations (Invariant 5 violation; investigation-only).
- Per-operator audit retention / archive policy (full table exposed; partition + archive is tech-debt).
- Re-rendering Grafana panels in-app (iframe-embed only).
- Bulk operations (mass-suspend, batch-refund).
- CIDR support in the IP allowlist (exact IPs only — same as JSON surface).

## Related

- [`docs/product-specs/admin-endpoints.md`](./admin-endpoints.md) — JSON surface this console consumes.
- [`docs/design-docs/ui-architecture.md`](../design-docs/ui-architecture.md) — implementation contract.
- [`docs/operations/deployment.md`](../operations/deployment.md) — Grafana embedding options.
- [`docs/exec-plans/active/0023-operator-admin.md`](../exec-plans/active/0023-operator-admin.md) — exec plan tracking the build.
