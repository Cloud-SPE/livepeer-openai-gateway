---
title: Customer portal
status: accepted
last-reviewed: 2026-04-26
---

# Customer portal

Self-service web app served at `/portal/*`. Authenticated by an existing API key (operator-issued today, self-service signup is its own plan). Built from `frontend/portal/`; consumes `/v1/account/*` (profile, keys CRUD, usage, top-ups, limits) and `/v1/billing/topup`.

This spec is the canonical UX contract — the page-by-page behavior the implementation must match. For _how_ the SPA is built (Lit + RxJS + modern CSS, light DOM, hash routing, npm workspaces), see [`ui-architecture.md`](../design-docs/ui-architecture.md).

## Audience and access model

- Customers who already have an API key. The portal does not issue the first key — operators do (see [`admin-endpoints.md`](./admin-endpoints.md) `POST /admin/customers/:id/api-keys`).
- Auth: paste API key → validated by `GET /v1/account` → stored under `sessionStorage["bridge.portal.session"]`. Tab-scoped — closing the tab signs the customer out.
- All requests carry `Authorization: Bearer <api-key>`. A 401 from any endpoint clears the session and bounces back to sign-in.

## Display rules

- **USD** is shown to two decimals (`$12.34`). Negative balances render with a leading minus (`-$0.50`) — operators can push the reserved field below zero during corrections.
- **Tokens** render with locale grouping (`50,000`).
- **Dates** render via `toLocaleString`. Mtime / "joined" / "last used" all use the same renderer.
- **Tier** is shown lowercase in the pill (`prepaid`) and capitalized in the dashboard / settings (`Prepaid`). The `tier` column in JSON is always lowercase.
- **API keys** are never echoed in lists. The cleartext is shown exactly once in the create-key flow with a one-tap copy button.
- **Color**: OKLCH palette via `light-dark()`. Theme follows OS preference; no in-app toggle in v1.

## Pages

The app shell is a top bar (brand · nav · tier pill + balance + sign-out) plus a routed `<main>` outlet. Hash routing; route swaps wrapped in `document.startViewTransition` where supported.

### `/portal/` — sign-in

A single card with one input (`type="password"`, monospace placeholder `sk-live-...`). Submit posts the key as Bearer to `GET /v1/account`. On success, store the session and emit `bridge:authenticated`. On failure, show the server's `error.message` in a danger-tinted block. Submit button shows a spinner while pending; the input is disabled.

### `#dashboard`

Default landing post-auth. Three tiles in a responsive grid:

- **Balance** — `$<balance_usd>`. Subtitle `Reserved $<reserved_usd>` only when non-zero.
- **Free-tier tokens remaining** (free tier only) — token count + a 6px progress bar (filled width based on a 100,000 baseline) + reset date. Marked `data-low="true"` when remaining < 10,000 — `:has()` flips the tile border to `--warning`.
- **Tier** — capitalized name, "Manage keys →" link.

Header has a "Top up" CTA that navigates to `#billing`.

### `#keys`

Table of API keys (label, created, last used, status, revoke action). Empty-state copy: "No keys yet — create one to get started."

**Create key** — header button opens a modal: label input (max 64), Cancel + Create. After successful POST, the modal closes and the cleartext key appears at the top of the page in a success-tinted banner with `<code>` (user-select: all), Copy, and Dismiss. **The cleartext is shown exactly once and never refetchable.**

**Revoke** — per-row button opens a confirm dialog with body `Revoke <label-or-"unlabeled key">? Any service using it will start receiving 401 errors immediately.` Single-click confirm.

**Self-revoke guard** — if the customer has only one active key, the client refuses to call `DELETE` and surfaces `You can't revoke the key you're signed in with. Sign in with a different key first.` (The server's 412 is the real defense; this is a UX hint to avoid the dead-end.)

### `#usage`

Three group-by buttons (`day`, `model`, `capability`). Selection triggers a fresh `GET /v1/account/usage?group_by=...`. Default `day`, last 30 days. Renders totals (request count, prompt + completion tokens, USD spent) above a table. Header column label flips with the selection (`Date` / `Model` / `Capability`).

### `#billing`

Top-up section: four preset buttons (`$10`, `$25`, `$50`, `$100`) plus a number input for custom amounts. Selecting a preset fills the input. Submit posts `{ amount_usd_cents: <amount * 100> }` to `/v1/billing/topup`, then redirects to the returned Stripe Checkout URL via `window.location.assign(url)`.

Below: a history table (Date, Amount, Status, Stripe session). Status renders as a colored badge (`succeeded` = success, `failed`/`refunded`/`disputed` = danger, `pending` = muted).

`/portal/billing/return` is the Stripe Checkout success-url target. (v1 polls `/v1/account/topups` until the row settles or 30s elapses; the implementation surface lives in `topupsService.pollUntilSettled`.)

### `#settings`

Read-only. Two cards:

- **Account** — email, tier, status, joined date.
- **Rate limits** — `tier`, `Concurrent`, `Requests / min`, `Tokens / req`, `Monthly quota` (or "unlimited" when `monthly_token_quota` is null). Backed by `GET /v1/account/limits`.

## Toasts

The app shell mounts `<bridge-toast-stack>` once. Components emit `bridge:toast` events with `{ kind: 'info'|'success'|'warning'|'error', message, ttlMs? }`. Default TTL 5s. The stack stacks newest-on-top, dismisses on TTL.

## Out of scope (v1)

- Self-service signup / first-key issuance.
- OAuth / SSO / passwordless email links.
- Multi-tenant org / team management.
- In-app support, chat, ticketing.
- Mobile apps (responsive web only).
- Per-minute / concurrency budget visualization (Redis counters; ephemeral, stale by render time).
- Real-time charts (vanilla CSS bars only — full chart library is Phase 2).
- CSV export of usage rows (deferred; `usage` returns JSON the browser can format).

## Related

- [`docs/design-docs/ui-architecture.md`](../design-docs/ui-architecture.md) — implementation contract.
- [`docs/product-specs/topup-prepaid.md`](./topup-prepaid.md) — Stripe Checkout flow + webhook semantics.
- [`docs/exec-plans/completed/0022-customer-portal.md`](../exec-plans/completed/0022-customer-portal.md) — exec plan tracking the build.
