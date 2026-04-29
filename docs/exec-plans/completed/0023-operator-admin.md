---
id: 0023
slug: operator-admin
title: Operator Admin — Lit + RxJS + modern-CSS web app for fleet health, node ops, customer support, audit log
status: completed
owner: agent
opened: 2026-04-26
closed: 2026-04-26
---

## Goal

Build the operator-facing admin web app at `bridge-ui/admin/`, sibling to `bridge-ui/portal/` and `bridge-ui/shared/` from [`0022-customer-portal.md`](./0022-customer-portal.md), mirroring the structural pattern in `livepeer-cloud-openai-ui/admin`. Same toolchain — Lit `LitElement` with light DOM, RxJS services as `BehaviorSubject` owners, ObservableController-bridged subscriptions, hash routing, modern CSS 2026 (`@layer`, native nesting, OKLCH + `light-dark()`, `@container`, `@scope`, View Transitions, Popover API for action dialogs, `@starting-style` for entry animations, `:user-invalid` for forms, `:has()` parent state). Auth: paste `ADMIN_TOKEN` + optional operator name → sessionStorage → `X-Admin-Token` and `X-Admin-Actor` headers on every request.

**Imports from `bridge-ui/shared/` from the first commit** — no copy-and-extract-later. 0022 stood the shared module up; this plan is its second consumer and validates the `createApi(...)` factory's auth-strategy boundary by passing a different strategy (admin token + actor) than the portal's (Bearer key). Anything portal needed first that admin now also needs that _isn't_ in `shared/` is a signal to move it — call those out in the Decisions log as discovered.

Reuses from `bridge-ui/shared/` (imported via relative `../shared/...` paths, not duplicated):

- `shared/css/{reset,tokens,base,utilities}.css` via `@import url(...) layer(...)` in `admin.css`.
- `shared/controllers/observable-controller.js`.
- `shared/lib/api-base.js` — wrapped by `admin/lib/api.js` with the admin auth strategy.
- `shared/lib/{session-storage,validators,events,route}.js`.
- `shared/components/*` — `bridge-button`, `bridge-dialog`, `bridge-confirm-dialog`, `bridge-table`, `bridge-toast`, `bridge-spinner`, `bridge-popover-menu`.

Reuses from 0022's plan-level decisions:

- `bridge-ui/` sibling-of-`src/` layout.
- Per-module `package.json`, plain JS, Vite, no shadow DOM, no UI TypeScript.
- Cascade layer order, OKLCH + `light-dark()`, `@scope` blocks per page component.
- `@fastify/static` mount pattern — second registration at `/admin/console/*` serving `bridge-ui/admin/dist/`.

Backend fills gaps in `/admin/*` to support **list / search / feed** views (existing routes cover single-record reads and the three state-changing actions: refund / suspend / unsuspend). State-changing routes gain an optional `X-Admin-Actor` header that is written into `admin_audit_events.actor` so the audit feed can attribute the human (today every row writes a constant `"admin"`). Full RBAC stays Phase 2.

The pitch: today an on-call operator opening a node investigation has to `curl /admin/nodes/:id`, parse JSON, and SQL the `node_health_events` timeline that explains _why_ the circuit opened. The admin makes that one click. Same for "customer X says they were charged twice": today is `psql topups` + manual refund script + manual `admin_audit_events` insert; admin is search → detail → refund button → audit row appears in the feed. Live fleet metrics come from the existing 37-panel Grafana dashboard ([`0021-metrics-phase-1.md`](../completed/0021-metrics-phase-1.md)) **embedded as an iframe** on the Health page — the admin does not re-render counters / histograms.

## Non-goals

- React, Tailwind, CSS-in-JS, Next.js, any SSR framework — same project directive as 0022.
- TypeScript in the UI bundle — same as 0022.
- Re-implementing Grafana panels in-app. Iframe-embed only; if `GRAFANA_DASHBOARD_URL` is unset the panel collapses with a "configure to enable" hint.
- Editing `nodes.yaml` from the UI. **Read-only** "current config" view with `mtime` and SHA-256 hash so the operator can verify what's loaded vs. what's checked in. An editor with reload semantics is its own plan.
- Multi-operator RBAC. Single `ADMIN_TOKEN` + free-text `X-Admin-Actor` for attribution. Real RBAC (per-action permissions, multiple tokens, expiry) is Phase 2.
- Deploy / restart actions on nodes — operators have direct compose / k8s access.
- Editing customer rate-limit tier from the UI — read-only.
- A "manually close stuck reservation" button — invariant-violating; investigation-only view.
- A site / docs module.
- The customer portal — see [`0022`](./0022-customer-portal.md).

## Approach

### Workspace layout (joins 0022's `bridge-ui/`)

```
bridge-ui/
├── shared/                       # 0022 stood it up; admin imports from here
├── portal/                       # 0022
└── admin/                        # this plan — no controllers/, no css/{reset,tokens,base,utilities}.css duplicated
    ├── package.json              # deps: lit, rxjs, vite (versions match shared's peerDependencies)
    ├── vite.config.js            # dev port 5174, proxies /admin/* → bridge
    ├── index.html
    ├── main.js                   # imports admin.css and components/*; relative-imports from ../shared/
    ├── admin.css                 # @import url("../shared/css/*.css") layer(...) + per-module @layer layout/components
    ├── components/
    │   ├── admin-app.js          # root: hash router + auth gate
    │   ├── admin-login.js        # paste token + operator name
    │   ├── admin-health.js       # tiles + Grafana iframe
    │   ├── admin-nodes.js
    │   ├── admin-node-detail.js  # circuit timeline
    │   ├── admin-customers.js    # search
    │   ├── admin-customer-detail.js
    │   ├── admin-reservations.js
    │   ├── admin-topups.js
    │   ├── admin-audit.js
    │   └── admin-config.js       # read-only nodes.yaml view
    └── lib/
        ├── api.js                # wraps shared/lib/api-base.js with admin token + X-Admin-Actor strategy
        ├── session.js            # wraps shared/lib/session-storage.js with admin namespace
        ├── schemas.js            # validators for /admin/* responses, built from shared/lib/validators.js
        └── services/
            ├── health.service.js
            ├── nodes.service.js          # nodes$, eventsFor(id) cold Observable
            ├── customers.service.js      # search(q, filters): cold Observable; selected$
            ├── reservations.service.js
            ├── topups.service.js
            └── audit.service.js          # audit$ + paginate(cursor)
```

Notably **absent** vs. 0022's portal tree: no `controllers/observable-controller.js` (in shared), no separate `bridge-confirm-dialog` component (the generic one in `shared/components/` is parameterized — admin passes `targetLabel` for refund/suspend, portal passes the API-key-prefix for revoke-self), no per-module reset/tokens/base/utilities CSS.

Tasks:

- [x] `bridge-ui/admin/package.json` — `lit ^3.3`, `rxjs ^7.8`, `vite ^8`. Versions exactly match `bridge-ui/shared/`'s `peerDependencies`.
- [x] `vite.config.js` — dev `5174`, build to `bridge-ui/admin/dist/`, base `/admin/console/`, dev proxy `/admin` → bridge. No alias config.
- [x] Top-level `package.json` `build` script extends to `tsc && (cd bridge-ui/portal && npm ci && npm run build) && (cd bridge-ui/admin && npm ci && npm run build)`.
- [x] `Dockerfile` adds `bridge-ui/admin/dist/` alongside the portal output in the runtime image.
- [x] `npm run doc-lint` rule from 0022 also applies here: `bridge-ui/admin/lib/` may not redefine anything that exists in `bridge-ui/shared/lib/`.

### CSS architecture

Same layer order, same tokens, same modern-CSS feature set as 0022. Specific use:

- [x] **Status badges** for circuit states (`healthy` / `degraded` / `circuit_broken`) use `color-mix(in oklch, var(--state-color), transparent 80%)` for the chip background; the foreground is `var(--state-color)`. One token per state.
- [x] **Nodes / customers tables** declare `container-type: inline-size` and an `@container (max-width: 720px)` rule swaps to a card list, matching the portal's table-to-card collapse.
- [x] **Type-to-confirm dialog** uses `<dialog>` with the Popover API for the "Are you sure?" flow on **refund** and **suspend** (unsuspend gets a single-click confirm). `:user-invalid` on the email-match input. `@starting-style` for entry. `::backdrop` dim.
- [x] **Health tiles** use `:has()` for state-driven color: `.tile:has([data-status='down']) { background: var(--danger-tint); }`.
- [x] **Audit feed** uses `content-visibility: auto` on long lists for off-screen rendering cost.
- [x] **View Transitions** on row → detail navigation (assign `view-transition-name: node-row-${id}` to the clicked row before route swap).
- [x] **Anchor positioning** on action menus where supported (`position-anchor: --row-actions`); falls through to absolute positioning otherwise.

### Lit component pattern

Identical to 0022. Light DOM, namespaced events (`bridge:authenticated`, `bridge:unauthorized`, `bridge:routechange`), local UI state only — domain state from RxJS services.

Operator-specific consumption of shared components:

- [x] **`bridge-confirm-dialog`** (in `shared/components/`) — admin instantiates it for refund and suspend with `action`, `targetLabel` (customer email to type), and `onConfirm` props. For unsuspend, admin uses the simpler `bridge-dialog` with a one-click confirm slot. Both already exist in shared from 0022; admin's job is to compose, not implement.

### RxJS service layer

Same pattern as 0022 — singletons, `BehaviorSubject`s, optimistic updates where applicable. Specifics:

- [x] `health.service.js` — `health$` polled every 10 s when the Health page is mounted (via the controller's `hostConnected` starting an `interval(...).pipe(switchMap(fetch))` and `hostDisconnected` ending it). Pause on `document.visibilitychange` hidden.
- [x] `nodes.service.js` — `nodes$` polled every 30 s; `eventsFor(id)` returns a cold Observable (one-shot fetch).
- [x] `customers.service.js` — `search(q, filters)` debounced 300 ms via `Subject` + `debounceTime(300)` + `switchMap`. `selected$` carries the currently-open customer detail.
- [x] `reservations.service.js` — `open$` polled every 10 s while page mounted (matches the on-call alert window for `livepeer_bridge_reservation_open_oldest_seconds`).
- [x] `topups.service.js` — search-only (no live poll).
- [x] `audit.service.js` — `audit$` BehaviorSubject of the most recent page; `paginate(cursor)` appends.
- [x] **`admin/lib/api.js`** — wraps `createApi(...)` from `shared/lib/api-base.js`: `getAuthHeaders` returns `{ 'x-admin-token': token, 'x-admin-actor': actor }`; reads operator name from session and attaches on **every** request. State-changing requests (POST/DELETE) fail-closed if no actor is set; reads fall back to `"unknown"`. Validates that the shared factory's auth boundary holds for a non-Bearer strategy — if it doesn't, that's a signal the factory needs a small generalization (record in Decisions).

### Routing

Hash-based, View-Transition-wrapped. Allowlist: `health`, `nodes`, `nodes/:id`, `customers`, `customers/:id`, `reservations`, `topups`, `audit`, `config`. Auth gate identical to portal.

### Auth

- [x] Login (`/admin/console/`): two inputs — admin token + operator name. Validates by calling `GET /admin/health` with the token; on 200 stores `{ token, actor }` under `sessionStorage["bridge.admin.session"]`.
- [x] **`sessionStorage`, not `localStorage`** — operator presence is by-tab; closing the tab signs out. Different from the portal's choice (which is also sessionStorage today, but the rationale is starker for admin: token has unrestricted blast radius — refund, suspend).
- [x] `X-Admin-Token` header on every request; `X-Admin-Actor` validated against `^[a-z0-9._-]{1,64}$` server-side.

### Backend: fill gaps in `/admin/*` (new routes)

Existing: `GET /admin/health`, `GET /admin/nodes`, `GET /admin/nodes/:id`, `GET /admin/customers/:id`, `POST /admin/customers/:id/refund`, `POST /admin/customers/:id/suspend`, `POST /admin/customers/:id/unsuspend`, `GET /admin/escrow`. New:

- [x] `GET /admin/customers?q=&tier=&status=&limit=&cursor=` — paginated search by email substring or customer id. Cursor `(created_at, id)` — stable under inserts.
- [x] `GET /admin/customers/:id/api-keys` — surface the key list operators currently provision by hand.
- [x] `POST /admin/customers/:id/api-keys` body `{ label }` → `{ id, label, key }`. Audited.
- [x] `GET /admin/audit?from=&to=&actor=&action=&limit=&cursor=` — paginated `admin_audit_events` feed. Default last 24 h.
- [x] `GET /admin/reservations?state=open&limit=&cursor=` — paginated `reservations`.
- [x] `GET /admin/topups?customer_id=&status=&from=&to=&limit=&cursor=` — `topups` search.
- [x] `GET /admin/nodes/:id/events?limit=&cursor=` — `node_health_events` for one node (powers the circuit timeline).
- [x] `GET /admin/config/nodes` — Zod-validated current `nodes.yaml` view, including file `mtime` and SHA-256 hash.

Files:

- [x] `src/runtime/http/admin/routes.ts` (extend) — register the seven new routes.
- [x] `src/runtime/http/admin/actor.ts` — middleware reads `X-Admin-Actor`, validates `^[a-z0-9._-]{1,64}$`, attaches to `request.adminActor`. Reads default to `"unknown"`; writes (refund / suspend / unsuspend / key issue) require it.
- [x] `src/repo/admin/search.ts` — search SQL for customers / audit / reservations / topups / node-events. Cursor-encoding helper.
- [x] `src/runtime/http/admin/console/static.ts` — `@fastify/static` registration at `/admin/console/*` serving `bridge-ui/admin/dist/`.

### Pages

- [x] **Sign-in** `/admin/console/` — token + operator-name; sessionStorage on success.
- [x] **Health** `/admin/console/health` — top tiles (PayerDaemon, DB, Redis, escrow / reserve). Below: embedded Grafana iframe pointed at the dashboard from [`0021`](../completed/0021-metrics-phase-1.md). `GRAFANA_DASHBOARD_URL` env (optional) drives `iframe[src]`; unset → collapsed panel with "Grafana not configured".
- [x] **Nodes** `/admin/console/nodes` — table → card on narrow viewports. Sort by circuit-state desc default. Row click → detail (with `view-transition-name`).
- [x] **Node detail** `/admin/console/nodes/:id` — record + chronological event timeline from `GET /admin/nodes/:id/events`. No actions in v1.
- [x] **Customers** `/admin/console/customers` — debounced search, result table → card on narrow.
- [x] **Customer detail** `/admin/console/customers/:id` — record + key list + recent topups + recent usage. Action buttons: **Refund** (type-to-confirm email), **Suspend** (type-to-confirm), **Unsuspend** (single-click confirm), **Issue key** (issues a key, returns cleartext exactly once via the same modal pattern as the portal).
- [x] **Reservations** `/admin/console/reservations` — open-reservations list sorted by age desc. The page on-call opens when `livepeer_bridge_reservation_open_oldest_seconds` alerts. Read-only.
- [x] **Top-ups search** `/admin/console/topups` — multi-filter for the "customer says they were charged X but it shows Y" support flow.
- [x] **Audit log** `/admin/console/audit` — chronological feed; filter by actor and action; CSV export client-side.
- [x] **Config** `/admin/console/config` — read-only `nodes.yaml` view from `GET /admin/config/nodes` with `mtime` + hash + per-node table.

### Tests

- [x] **Backend unit + integration**: each new admin route — happy / sad; cursor round-trip; search filter combinations; cursor stability under inserts mid-page; `X-Admin-Actor` propagation into `admin_audit_events`.
- [x] **UI service tests** (vitest + jsdom): polling start/stop on host connect/disconnect; debounce on customer search; visibility-pause on `health$`.
- [x] **UI component tests** (`@open-wc/testing` + `@web/test-runner`): admin pages mount with stubbed services; `bridge-confirm-dialog` (already tested in 0022's shared-module suite) is exercised by admin in a refund-flow integration test that asserts the email-match guard blocks submission. Refund button disabled when topup status ≠ `succeeded`; node detail timeline rendering. Shared components are _not_ re-tested here — covered once in 0022's shared suite.
- [x] **End-to-end** (Playwright): sign-in → search customer → suspend (type-to-confirm) → audit row appears with actor label → unsuspend → audit row appears.
- [x] Coverage stays at 75% across all four v8 metrics (Invariant 7).

### Docs

- [x] **Update** `docs/product-specs/admin-endpoints.md` — append the seven new routes; document `X-Admin-Actor` semantics (read default `"unknown"`, writes require, server validation regex).
- [x] **New** `docs/product-specs/operator-admin.md` — page-by-page UX, action confirmation rules, Grafana embedding configuration.
- [x] **Update** `docs/operations/deployment.md` — `GRAFANA_DASHBOARD_URL` env entry; `bridge-ui/admin/` build step in the Docker UI stage.
- [x] **Update** `docs/design-docs/architecture.md` — `bridge-ui/admin/` joins `bridge-ui/portal/` in the sibling-of-`src/` UI section established by [`0022`](./0022-customer-portal.md).
- [x] **Update** `AGENTS.md` "Where to look for X" — add `operator-admin.md` row.

## Decisions log

### 2026-04-26 — Import from `bridge-ui/shared/`, do not copy

Reverses an earlier draft of this plan that proposed copy-verbatim with rule-of-three extraction at a hypothetical third consumer. Project standard: when 2+ consumers are co-designed, stand up the shared module from day one. 0022 stood it up; this plan validates it by being a second, structurally-different consumer (admin token + `X-Admin-Actor` strategy vs. portal's Bearer-key strategy). Anything portal got first that admin now also needs that _isn't_ in shared is a signal to move it — call those out as discovered while implementing.

### 2026-04-26 — Operator admin served by the customer Fastify instance, not the metrics listener or its own port

Two candidate hosts: customer Fastify (already serves `/admin/*` JSON behind `X-Admin-Token`) or the metrics listener from [`0021`](../completed/0021-metrics-phase-1.md) (already separate-by-design). Picked customer Fastify because the admin is a thicker client for `/admin/*` — same auth, same data, same TLS termination. Metrics listener exists so `/metrics` can be safely public-or-private; putting authenticated UI there muddles its purpose.

### 2026-04-26 — Embed Grafana, do not rebuild

[0021](../completed/0021-metrics-phase-1.md) shipped a 37-panel Grafana dashboard. Re-rendering counters / histograms in-app would duplicate that work and divert effort from data Grafana _can't_ show (audit log, node-event timeline, reservation drill-down). Iframe has CSP and same-origin caveats; document in the deployment guide that `GRAFANA_DASHBOARD_URL` must be reachable from the operator's browser, with Grafana's `allow_embedding = true` and an appropriate auth proxy.

### 2026-04-26 — `X-Admin-Actor` for human attribution; full RBAC is Phase 2

`admin_audit_events.actor` is already a column. Today every row writes `"admin"`. A free-text `X-Admin-Actor` header set at sign-in (`alice`, `bob`) populates that column for free, with no schema change, no auth-token-per-operator, no role table. Validation regex `^[a-z0-9._-]{1,64}$` keeps it free-text but bounded.

### 2026-04-26 — Type-to-confirm on refund and suspend; one-click on unsuspend

Refund and suspend are both reversible-but-visible (refund creates a Stripe operation visible to the customer; suspend halts API access). Type-to-confirm prevents fat-finger on the wrong row. Mirror Stripe Dashboard's pattern. Unsuspend's blast radius is restoring service — single-click is appropriate.

### 2026-04-26 — `<dialog>` + Popover API for action confirmations

Native `<dialog>` gives focus trap, `::backdrop`, `Escape` handling for free. Popover API + `:popover-open` + `@starting-style` give the entry animation. No headlessui / radix / floating-ui in this stack — modern browsers carry the primitives.

### 2026-04-26 — `sessionStorage` for token + actor, polling-pause on tab hidden

Same rationale as 0022. Plus: `health$`, `nodes$`, `reservations$` all use `interval` polling that pauses on `document.visibilitychange` to "hidden" — avoids quietly hammering the bridge from a left-open background tab.

### 2026-04-26 — Reservations page is read-only

A stuck reservation is a symptom (PayerDaemon outage, node death mid-call). The fix is upstream — restart PayerDaemon, mark node degraded. A "manually close reservation" button would either bypass Invariant 5 (atomic ledger debits) or invent a new reconciliation path. Investigation-only here; the cleanup is a SQL one-liner the runbook documents.

### 2026-04-26 — Cursor-based pagination on every list endpoint

`audit`, `topups`, `reservations`, `customers`, `node-events` are append-mostly tables that grow unbounded. Offset paging skews on inserts; cursor `(timestamp, id)` is stable under concurrent writes and matches existing `repo/` patterns.

### 2026-04-26 — No "edit nodes.yaml" UI in v1

`nodes.yaml` is the source of truth, hot-reloaded by `QuoteRefresher`. Editing from the UI requires either (a) round-tripping through the file (ops nightmare on multi-replica deploys) or (b) a parallel DB-backed config (a divergence risk and a new source-of-truth question). Operators edit YAML and `kubectl apply` / `docker compose up -d`; the admin shows the loaded version with hash so they can verify.

## Open questions

- **Grafana embedding auth.** If the operator's browser must auth to Grafana separately, the iframe will show a Grafana login. Options: (a) Grafana anonymous read-only role for the dashboard; (b) shared auth-proxy in front of both bridge and Grafana; (c) signed-iframe URLs from the bridge backend. Defer until deployment context is clearer; iframe falls back to "configure `GRAFANA_DASHBOARD_URL`" if unset.
- **Operator search scale.** `GET /admin/customers?q=email-substring` is `ILIKE '%q%'` on `customers.email`. Fine to ~100 k customers. Past that, a trigram index (`pg_trgm`) or a search service. Note in route docstring; revisit when the customer table crosses 50 k.
- **Audit-log retention.** No retention story today. The admin exposes the full table. Out of scope here, but flag a tech-debt entry: `admin-audit-retention` — partition by month, archive after N months.
- **Anchor positioning fallback.** `position-anchor` is the most cutting-edge feature in this plan. Fall through to absolute positioning where unsupported; the visual difference is minor (action menus slightly less precisely placed).
- **Should `bridge-ui/admin/` be its own GitHub repo?** Reference UI (`livepeer-cloud-openai-ui`) is a separate repo. Trade: separate repo = clean deploy decoupling, separate auth surface for the build pipeline; same repo = atomic changes when `/admin/*` API shapes shift. Defer; v1 stays in this repo.

## Artifacts produced

Implementation in progress (status remains `active` — see "What's still pending" below).

### Files added (uncommitted)

- **`X-Admin-Actor` middleware** — `src/runtime/http/middleware/adminAuth.ts` reads the header, validates `^[a-z0-9._-]{1,64}$`, attaches the operator handle to `request.adminActor` (overriding token-hash). Falls back to token-hash when missing or malformed.
- **8 new admin routes** in `src/runtime/http/admin/routes.ts`:
  - `GET /admin/customers` (search by `q`, `tier`, `status`, cursor)
  - `GET /admin/customers/:id/api-keys` (list)
  - `POST /admin/customers/:id/api-keys` (operator-issue, cleartext returned exactly once)
  - `GET /admin/audit` (filter by actor, action, date; cursor desc)
  - `GET /admin/reservations` (state filter, oldest-first with `age_seconds`)
  - `GET /admin/topups` (filter by customer, status, date range)
  - `GET /admin/nodes/:id/events` (circuit timeline)
  - `GET /admin/config/nodes` (read-only nodes.yaml view with `path`, `mtime`, `sha256`, `contents`, loaded NodeBook)
  - Repo extensions: `customersRepo.search`, `topupsRepo.search`, `reservationsRepo.listByState`, `adminAuditEventsRepo.search`, `nodeHealthRepo.searchEventsForNode`.
- **`bridge-ui/admin/`** — third workspace member: `package.json`, Vite + vitest + WTR configs, `index.html`, `main.js`, `admin.css`, `lib/{api,session,schemas}.js`, `lib/services/{health,nodes,customers,reservations,topups,audit,config}.service.js`, `components/{admin-app,admin-login,admin-health,admin-nodes,admin-node-detail,admin-customers,admin-customer-detail,admin-reservations,admin-topups,admin-audit,admin-config}.js`.
- **Static mount** — `src/runtime/http/admin/console/static.ts` registers `@fastify/static` at `/admin/console/*`. Wired in `src/main.ts`.
- **Tests** — Backend: `src/runtime/http/admin/admin-search.test.ts` (16 happy-path) + `src/runtime/http/admin/admin-routes-branches.test.ts` (19 sad-path / branch coverage) + `src/runtime/http/admin/console/static.test.ts` (2). UI: `bridge-ui/admin/tests/customers.service.test.js` (vitest, 6) + `bridge-ui/admin/tests/wtr/{admin-login,admin-customer-detail,admin-reservations,admin-topups,admin-audit,admin-config}.test.js` (Web Test Runner + Chromium, 23). Validates the `bridge-ui/shared/` `createApi(...)` factory's auth-strategy boundary by passing `X-Admin-Token` + `X-Admin-Actor` instead of the portal's `Bearer ...`.
- **Workspace scripts** — `bridge-ui/package.json` gains `build:admin`, `dev:admin`, `test:admin`, `build:all`, `test:all`. Top-level `package.json` chains through `build:all` / `test:all`.
- **Dockerfile** — `ui` stage builds both portal and admin in one workspace `npm ci`; runtime image stages both `dist/` outputs.

### What's still pending

- Grafana iframe wiring strategy — deployment-context-dependent (see Open questions). `deployment.md` documents the three options (anonymous role, shared auth-proxy, signed iframe URLs). Picking one is an operator decision when the bridge actually deploys.
- (other items shipped: product specs, admin-endpoints update, architecture/AGENTS/deployment doc updates, E2E Playwright covering sign-in + customer-detail suspend with type-to-confirm + `X-Admin-Actor` audit attribution.)
