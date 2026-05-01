---
title: Engine operator dashboard
status: accepted
last-reviewed: 2026-04-26
---

# Engine operator dashboard

A minimal read-only dashboard scaffold the engine ships at
`@cloudspe/livepeer-openai-gateway-core/dashboard` (post-stage-3) so OSS adopters can
see node-pool health and payer-daemon status without building their
own admin UI from scratch.

## Why this exists

OSS adopters of the engine fall into two operational modes:

- **No shell**: a small operator running `livepeer-bridge-core` directly
  (e.g. `examples/minimal-shell`) wants visibility into node health
  without standing up a custom dashboard.
- **With shell**: an operator running this repo's full shell already has
  `frontend/admin/` (a richer Lit + RxJS SPA at `/admin/console`) and
  doesn't need this dashboard. The engine's dashboard is OFF by default
  in the shell; both can coexist when enabled.

The engine dashboard is opt-in via `BRIDGE_DASHBOARD_ENABLED=true`. Off by
default in this repo (the shell's admin SPA covers the use case).

## Scope

v1 is **strictly read-only**. Per exec-plan 0025 design choice, action
surfaces (manually circuit-break a node, force-refresh quotes, etc.) are
deferred. The scope is intentionally narrow so the engine dashboard can
ship without dragging UI build tooling (Vite, Lit, RxJS) into the engine
peer-dep footprint.

Pages (v1):

- `GET /admin/ops/` — server-rendered HTML index with payer-daemon status +
  node-pool table (id, url, circuit status). Plus a build-info footer.
- `GET /admin/ops/style.css` — minimal vanilla CSS.

Both routes go through the operator-supplied `AdminAuthResolver`
(`src/interfaces/adminAuthResolver.ts`).

## Tech stack

Vanilla TypeScript on the server (template strings render HTML) and zero
JavaScript on the client. No SSR framework, no React, no Lit, no Vite.

The engine package's `peerDependencies` therefore stays minimal: just
Fastify and `@fastify/static` (the latter is unused by the dashboard
itself but already required by the shell — the dashboard imports
nothing UI-shaped).

## Auth

The operator wires an `AdminAuthResolver` (defined in exec-plan 0024,
engine-extraction-interfaces). Two reference impls ship in this repo:

- `createBasicAdminAuthResolver({user, pass})` — HTTP Basic auth from
  `BRIDGE_OPS_USER` / `BRIDGE_OPS_PASS` env vars. For solo / small
  operators without a token-issuing shell.
- `createAdminAuthResolver({config: AdminConfig})` — wraps the existing
  shell-side bearer-admin-auth scheme plus optional `X-Admin-Actor`
  attribution. Production path.

When `resolve()` returns null, the dashboard sends 401 with a
`WWW-Authenticate: Basic realm="..."` header so browsers re-prompt.

## What the engine dashboard is NOT

- It is **not** the shell's admin SPA. The shell's
  `frontend/admin/` (Lit + RxJS, customer search, audit log, refunds,
  etc.) lives at `/admin/console/*`. That SPA is shell-owned and
  customer-facing-adjacent; it stays in the proprietary shell post-split.
- It is **not** a metrics dashboard. Operators with Prometheus / Grafana
  set up should use that. The bridge's `livepeer_bridge_*` metrics emit
  to whatever scraper is configured per
  [`metrics.md`](metrics.md) and
  [`livepeer-modules-conventions/metrics-conventions.md`](https://github.com/Cloud-SPE/livepeer-modules/blob/main/docs/conventions/metrics.md).
- It is **not** a place for action surfaces in v1.

## Cross-references

- The five operator-overridable adapter contracts that the engine exposes
  are in exec-plan 0024 (engine-extraction-interfaces); this dashboard
  consumes the `AdminAuthResolver` adapter.
- The dispatch + routing reshape that lets the dashboard read engine
  state via `EngineAdminService` is in exec-plan 0025
  (engine-extraction-dispatchers).
