---
id: 0012
slug: admin-endpoints
title: Admin / ops endpoints
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement `runtime/admin/`: ops endpoints for operators to inspect system state without SSH-ing into the DB. Health, NodeBook status, customer lookup, escrow status, manual refund. Protected by a separate admin token (not customer API keys).

Depends on: most prior plans (inspection surfaces).

## Non-goals

- No UI. Endpoints return JSON; UI is a separate future repo or v2 effort.
- No bulk operations. One customer at a time for v1.
- No automated customer actions (ban, mass refund). Manual only.

## Approach

- [ ] Admin auth: separate `ADMIN_TOKEN` env var, constant-time compare, IP allowlist
- [ ] `GET /admin/health` — full system health (daemon, Postgres, Redis, Stripe, NodeBook summary)
- [ ] `GET /admin/nodes` — NodeBook state: nodes + quotes + health + capacity
- [ ] `GET /admin/nodes/:id` — detail including recent failure history
- [ ] `GET /admin/customers/:id` — customer + balance/quota + last N usage records
- [ ] `POST /admin/customers/:id/refund` — manual refund with reason
- [ ] `POST /admin/customers/:id/suspend` — flip status
- [ ] `GET /admin/escrow` — current TicketBroker deposit/reserve (via ChainInfo provider)
- [ ] `GET /admin/reconciliation` — three-ledger summary (CustomerLedger USD, PayerDaemon EV, on-chain redemptions)
- [ ] Audit log table: every admin action recorded with actor + timestamp + payload
- [ ] Tests for each endpoint
- [ ] Author `docs/product-specs/admin-endpoints.md`

## Decisions log

_(empty)_

## Open questions

- Admin auth beyond a shared token: basic auth? OAuth? Shared token is simplest and sufficient for ops-internal usage.
- IP allowlist enforcement: at reverse proxy or in-app? In-app lets the config live in-repo.
- Audit log retention: 1 year? Forever? 1 year for starters; trim older in a scheduled job.
- Do we expose a `/admin/metrics` Prometheus scrape endpoint here, or on the main HTTP port? Main port behind auth is cleanest.

## Artifacts produced

_(to be populated on completion)_
