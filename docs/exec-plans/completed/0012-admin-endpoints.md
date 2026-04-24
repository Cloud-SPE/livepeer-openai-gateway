---
id: 0012
slug: admin-endpoints
title: Admin / ops endpoints
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Implement `runtime/admin/`: ops endpoints for operators to inspect system state without SSH-ing into the DB. Health, NodeBook status, customer lookup, escrow status, manual refund. Protected by a separate admin token (not customer API keys).

Depends on: most prior plans (inspection surfaces).

## Non-goals

- No UI. Endpoints return JSON; UI is a separate future repo or v2 effort.
- No bulk operations. One customer at a time for v1.
- No automated customer actions (ban, mass refund). Manual only.

## Approach

- [x] Admin auth: `ADMIN_TOKEN` env + `timingSafeEqual` compare + optional `ADMIN_IP_ALLOWLIST` (exact IPs; CIDR is tech-debt).
- [x] `GET /admin/health` — composed view: PayerDaemon.isHealthy() + Postgres ping + Redis ping (optional) + NodeBook summary.
- [x] `GET /admin/nodes` — NodeBook state list.
- [x] `GET /admin/nodes/:id` — detail + last 20 `node_health_event` rows.
- [x] `GET /admin/customers/:id` — customer + last 20 topups + last 50 usage_records.
- [x] `POST /admin/customers/:id/refund` — ledger-only `reverseTopup` with required non-empty `reason`.
- [x] `POST /admin/customers/:id/suspend` + `/unsuspend` — status flip pair.
- [ ] `GET /admin/escrow` — PayerDaemon `getDepositInfo` view (on-chain reads deferred; tech-debt).
- [ ] `GET /admin/reconciliation` — deferred to the ChainInfo provider plan.
- [x] Audit log: `admin_audit_event` table; every request writes a row keyed on `sha256(token)[:16]`.
- [x] 12 tests: admin auth (missing / wrong / IP blocked) + every endpoint + refund math + audit rows.
- [x] Author `docs/product-specs/admin-endpoints.md`.

## Decisions log

### 2026-04-24 — Admin auth: constant-time `ADMIN_TOKEN` + optional IP allowlist, enforced in-app

Reason: Single shared token is sufficient for ops-internal use. Comparison via `timingSafeEqual` (min 32 chars). IP allowlist via comma-separated env list (exact IPs; CIDR is tech-debt); empty = allow all. In-app enforcement keeps the config in-repo and lets tests exercise it.

### 2026-04-24 — Descope on-chain reads: no `ChainInfo` provider in 0012

Reason: `/admin/escrow` and `/admin/reconciliation` on the plan list require a new `ChainInfo` provider (viem + RPC URL + contract ABIs + cross-ledger aggregation). That's a real addition for endpoints nobody is yet consuming. For v1 we ship what the bridge already knows:

- `GET /admin/escrow` → reads from PayerDaemon's `getDepositInfo` (bridge's view of escrow).
- `/admin/reconciliation` → deferred (tech-debt).

Upgrade path is additive when ops has a dashboard to consume it.

### 2026-04-24 — Manual refund via `service/billing.reverseTopup` — ledger-only

Reason: `POST /admin/customers/:id/refund` does NOT call Stripe's refund API. Operator issues the Stripe refund from the Stripe dashboard (a deliberate, human action). This endpoint just reverses our ledger entry — sets `topup.refunded_at`, decrements `customer.balance_usd_cents` by the topup amount with `max(0, balance - amount)`. The disconnect is intentional and matches the v1 "manual ops" stance from the architecture reference.

Reason field is **required** and rejected if empty — every reversal has a human-readable justification in the audit log.

### 2026-04-24 — Audit log: `admin_audit_event` table; actor is a SHA-256 prefix of the token

Reason: Every admin endpoint hit (success or failure) writes a row. Columns: `id`, `actor` (first 16 hex chars of `sha256(token)` — never store the raw token), `action` (route path + method), `target_id`, `payload` JSONB (request body snapshot), `status_code`, `occurred_at`. Actor-hashing means a leaked audit log doesn't leak the token; multiple operators sharing one token are indistinguishable (acceptable for v1).

Retention indefinite in v1; scheduled purge is tech-debt.

### 2026-04-24 — Admin routes on the main HTTP port under `/admin/*`

Reason: Keeps deployment simple. Isolation from customer traffic comes from the auth preHandler + optional IP allowlist, not a separate port. If ops wants a separate port later (smaller public blast radius), the route registration is one call to move.

### 2026-04-24 — Suspend / unsuspend as a symmetric pair; no bulk operations

Reason: `customer.status` already has `active | suspended | closed` from 0003. The admin endpoints just flip between `active` and `suspended`. `closed` remains an operator-only manual SQL action for v1 (it's a terminal state with refund implications). No bulk ops — one customer per request.

### 2026-04-24 — No Prometheus `/metrics` scrape endpoint in 0012

Reason: The Prometheus sink itself is tech-debt from 0011 (currently no-op). When the sink lands, the scrape endpoint is naturally added behind the same admin auth at `/admin/metrics`. Building it now with nothing to scrape would be theatrical.

## Open questions

- CIDR support in the IP allowlist (ops may eventually need it). Tech-debt with `ipaddr.js`.
- Tenant isolation when multiple operators share one token (audit log can't distinguish). Tracked if/when we onboard a second operator; single-operator is v1's assumption.

## Artifacts produced

- Schema: migration `migrations/0004_panoramic_doctor_doom.sql` — adds `admin_audit_event` (id, actor, action, target_id, payload, status_code, occurred_at) with `(actor, occurred_at)` index.
- Config: `src/config/admin.ts` — Zod env (`ADMIN_TOKEN` ≥ 32 chars, `ADMIN_IP_ALLOWLIST` comma-separated).
- Repo: `src/repo/adminAuditEvents.ts` — `recordEvent(...)`.
- Service: `src/service/admin/index.ts` — `createAdminService` with getHealth / listNodes / getNode / getCustomer / reverseCustomerTopup / suspendCustomer / unsuspendCustomer / getEscrow. Extended `service/billing/topups.ts` with `reverseTopup` (ledger-only, balance floored at 0, idempotent on refundedAt) and `setCustomerStatus`.
- Runtime: `src/runtime/http/middleware/adminAuth.ts` (preHandler with constant-time compare, IP check, audit-log write on reply close) + `src/runtime/http/admin/routes.ts` (8 routes).
- Tests (222 total passing, 12 new for 0012; 91.35% stmt / 80.28% branch / 94.9% func / 91.35% line): `src/runtime/http/admin/admin.test.ts`.
- Product-spec: `docs/product-specs/admin-endpoints.md` (`status: accepted`).
- Tech-debt: `ChainInfo` provider for on-chain reads; `/admin/reconciliation`; audit log retention + multi-operator identity; CIDR allowlist; Prometheus scrape endpoint.
