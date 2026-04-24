---
id: 0003
slug: customerledger
title: CustomerLedger schema, repo, and service
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Persist customer state: accounts, tier (free|prepaid), balance (USD for prepaid), quota (tokens for free), usage records, top-ups. Implement atomic debit/refund primitives that prevent concurrent-request double-spend. This is the authoritative billing source for the bridge.

Depends on: `0002-types-and-zod` (for type shapes and migration tool choice).

## Non-goals

- No Stripe integration yet. Top-ups are persisted here; payment flow comes in `0010-stripe-topups`.
- No admin UI. `0012-admin-endpoints` exposes ops views.
- No reconciliation dashboards.

## Approach

- [ ] Author Postgres schema matching Appendix A of `docs/references/openai-bridge-architecture.md`
  - `customer` (id, email, api_key_hash, tier, balance_usd_cents, quota_tokens_remaining, quota_reset_at, ...)
  - `usage_record` (one per request, tokens reported + local, cost, status)
  - `topup` (stripe_session_id, amount, status)
- [ ] Migration via chosen tool (from 0002)
- [ ] `providers/database` adapter (Postgres pool)
- [ ] `repo/customers`, `repo/usageRecords`, `repo/topups` — typed DB access
- [ ] `service/billing`:
  - `reserve(customerId, estCostCents)` — debits under row lock, returns a reservation token
  - `commit(reservationToken, actualCostCents, usageRecord)` — finalizes at end of request
  - `refund(reservationToken)` — returns reserved amount on failure
  - `creditTopup(customerId, amountCents)` — credits on Stripe webhook
- [ ] Free-tier variant: `reserveQuota(customerId, estTokens)`, etc.
- [ ] Concurrent-request correctness test (N parallel requests for same customer must serialize correctly)
- [ ] Author `docs/design-docs/tiers.md` + `docs/design-docs/pricing-model.md`

## Decisions log

_(empty)_

## Open questions

- Row locking strategy: `SELECT FOR UPDATE`, advisory locks, or transactional isolation level? Lean `FOR UPDATE` on customer row.
- Monetary precision: `bigint cents` (simple) vs `numeric(20,6)` for sub-cent precision (nicer for ETH-equivalent tracking). Lean cents.
- Quota reset timing: calendar month (first of next month) vs rolling 30 days? Calendar month matches customer mental model.

## Artifacts produced

_(to be populated on completion)_
