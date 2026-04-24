---
id: 0003
slug: customerledger
title: CustomerLedger schema, repo, and service
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Persist customer state: accounts, tier (free|prepaid), balance (USD for prepaid), quota (tokens for free), usage records, top-ups. Implement atomic debit/refund primitives that prevent concurrent-request double-spend. This is the authoritative billing source for the bridge.

Depends on: `0002-types-and-zod` (for type shapes and migration tool choice).

## Non-goals

- No Stripe integration yet. Top-ups are persisted here; payment flow comes in `0010-stripe-topups`.
- No admin UI. `0012-admin-endpoints` exposes ops views.
- No reconciliation dashboards.

## Approach

- [x] Author Postgres schema matching Appendix A of `docs/references/openai-bridge-architecture.md`
  - `customer` (id, email, api_key_hash, tier, balance_usd_cents, reserved_usd_cents, quota_tokens_remaining, quota_reserved_tokens, quota_reset_at, quota_monthly_allowance, rate_limit_tier, status)
  - `reservation` (id, customer_id, work_id UNIQUE, kind prepaid|free, amount_usd_cents, amount_tokens, state open|committed|refunded, created_at, resolved_at)
  - `usage_record` (one per request, tokens reported + local, cost_usd_cents, node_cost_wei, status, error_code)
  - `topup` (stripe_session_id UNIQUE, amount, status)
- [x] Migration via Drizzle-kit (`drizzle.config.ts`, `migrations/0000_dizzy_midnight.sql`, `npm run db:generate`, `npm run db:migrate`)
- [x] `providers/database` adapter (Postgres pool) — `src/providers/database.ts` + `src/providers/database/pg/index.ts`
- [x] `repo/customers`, `repo/reservations`, `repo/usageRecords`, `repo/topups` — typed DB access via Drizzle
- [x] `service/billing`:
  - `reserve({ customerId, workId, estCostCents })` — debits under row lock, returns ReservationId
  - `commit({ reservationId, actualCostCents })` — finalizes at min(actual, reserved), refunds delta
  - `refund(reservationId)` — returns the reservation; balance unchanged
  - `creditTopup({ customerId, stripeSessionId, amountUsdCents })` — credits on Stripe webhook
- [x] Free-tier variant: `reserveQuota` / `commitQuota` / `refundQuota` on `quota_tokens_remaining` + `quota_reserved_tokens`
- [x] Concurrent-request correctness test (N=20 parallel reserve on marginal balance; exactly floor(balance / cost) succeed; different customers don't serialize against each other) — `src/service/billing/billing.test.ts`
- [x] Author `docs/design-docs/tiers.md` + `docs/design-docs/pricing-model.md`

## Decisions log

### 2026-04-24 — Drizzle-kit as the migration + schema tool

Reason: Schema-as-code in TypeScript composes naturally with the Zod types in `src/types/` (core-belief #4, "Zod at every boundary") and avoids standing up a parallel ORM later. Tradeoff accepted: Drizzle's query builder is opinionated and somewhat less portable than plain SQL migrations via `node-pg-migrate`. If the opinionation proves costly, we can keep the existing SQL migration files and drop the query builder without a full rip.

### 2026-04-24 — Testcontainers (+ GH Actions service container) for Postgres-backed tests

Reason: Atomic-debit correctness is the load-bearing behavior this plan proves, so tests must run against real Postgres semantics — `pg-mem` notably does not faithfully emulate `SELECT … FOR UPDATE`, which is the one thing we are testing. Locally, Testcontainers spins an ephemeral PG image per run. In CI, GitHub Actions' `services: postgres` block exposes the same image on `localhost`, so the test code picks it up via connection env vars without launching Docker-in-Docker. No mocking of the DB, in line with the tests-stay-honest stance (repo core belief: "Enforce invariants, not implementations").

### 2026-04-24 — Monetary precision: `bigint` USD cents

Reason: Matches Appendix A of `docs/references/openai-bridge-architecture.md`. Integer math end-to-end eliminates FP drift and JS-`number` 2^53 concerns for USD balances over any realistic lifetime. Wei/ETH tracking stays on its own string-serialized bigint fields; no mixing of currencies in a single column.

### 2026-04-24 — Row lock via `SELECT … FOR UPDATE` on the customer row; no advisory locks yet

Reason: The atomic unit for reserve/commit/refund is exactly one row (the customer). `FOR UPDATE` gives the right lock shape — concurrent requests for the same customer serialize, different customers stay parallel — with no extra ceremony and no risk of app code forgetting to acquire a separate mutex. Advisory locks (`pg_advisory_xact_lock`) belong to cross-row workflows (e.g., a monthly quota-reset sweep); we'll introduce them alongside, not in place of, row locks if such a workflow lands later.

### 2026-04-24 — Calendar-month quota reset (first of next month, customer's wall clock)

Reason: Matches customer mental model from `PRODUCT_SENSE.md` ("100K tokens/month"). Rolling 30-day would be technically more uniform but surprises developers tracking usage against a month boundary. Reset time of day pinned to `00:00:00 UTC`.

## Open questions

- Connection env vars / config schema: defer to a small `src/config/database.ts` in this plan (Zod-validated).
- Quota-reset sweep: in-app cron vs external scheduler? Out of scope for 0003 — free-tier quota writes come from `service/billing`; the reset job ships in its own plan.

## Artifacts produced

- Drizzle schema: `src/repo/schema.ts` (customer, reservation, usage_record, topup + enums)
- Initial migration: `migrations/0000_dizzy_midnight.sql` + `migrations/meta/`
- Migration tooling: `drizzle.config.ts`; `npm run db:generate`, `npm run db:migrate`; `scripts/migrate.ts`
- Providers: `src/providers/database.ts` (interface) + `src/providers/database/pg/index.ts` (default pg impl)
- Config: `src/config/database.ts` (Zod-validated env → `DatabaseConfig`)
- Repo adapters: `src/repo/{customers,reservations,usageRecords,topups,db,migrate,index}.ts`
- Service: `src/service/billing/{errors,reservations,topups,index}.ts` — atomic reserve/commit/refund for both tiers + creditTopup
- Tests: `src/config/database.test.ts`, `src/repo/repo.test.ts`, `src/service/billing/billing.test.ts`, `src/service/billing/errors.test.ts` — 42 tests, 100% stmt / 85.84% branch / 100% func / 100% line coverage
- CI: `.github/workflows/test.yml` updated with `services: postgres` block
- Design-docs: `docs/design-docs/tiers.md`, `docs/design-docs/pricing-model.md` (both `status: accepted`); `docs/design-docs/index.md` updated
