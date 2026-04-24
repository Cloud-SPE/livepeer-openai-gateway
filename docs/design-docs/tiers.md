---
title: Customer tiers (Free and Prepaid)
status: accepted
last-reviewed: 2026-04-24
---

# Customer tiers

Two tiers at v1 launch: **Free** and **Prepaid**. Enterprise/Postpaid is explicitly deferred to v2+.

## Free tier

| Dimension            | v1 default                                     | Where enforced                                      |
| -------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Quota                | 100,000 tokens / calendar month                | `customer.quota_monthly_allowance` seeded at signup |
| Quota reset          | First of next month, `00:00:00 UTC`            | `customer.quota_reset_at`                           |
| Concurrent requests  | 1                                              | `service/rateLimit` (later plan)                    |
| Request rate         | 3 req/min, 200 req/day                         | `service/rateLimit`                                 |
| Max tokens / request | 1024                                           | `service/auth` (later plan)                         |
| Available models     | 1–2 cheapest (`tier_allowed: [free, prepaid]`) | `service/nodes` (later plan)                        |
| Streaming            | Allowed                                        | —                                                   |
| Signup requirement   | Verified email                                 | `runtime/signup` (later plan)                       |

### Reserve / commit / refund

The free tier shares the reserve-commit-refund pattern with prepaid, but operates on `quota_tokens_remaining` and `quota_reserved_tokens` instead of USD cents.

- `service/billing.reserveQuota({ customerId, workId, estTokens })` — decrements `available = quota_tokens_remaining − quota_reserved_tokens`, fails with `QuotaExceededError` if insufficient.
- `service/billing.commitQuota({ reservationId, actualTokens })` — finalizes at `min(actualTokens, reserved)`, refunds the delta.
- `service/billing.refundQuota(reservationId)` — returns the full reservation on any failure before tokens are delivered.

All three operate under `SELECT … FOR UPDATE` on the customer row, so concurrent requests for the same customer serialize.

### Quota reset cadence

Reset fires at the first of the next calendar month in UTC, matching the customer mental model in `PRODUCT_SENSE.md` (not a rolling 30-day window). The actual reset job is out of scope for 0003 and lands in its own exec-plan; 0003 only persists `quota_reset_at` so the job has a reliable target.

## Prepaid tier

| Dimension         | v1 default                                                     | Where enforced                       |
| ----------------- | -------------------------------------------------------------- | ------------------------------------ |
| Balance unit      | `balance_usd_cents` bigint                                     | `customer.balance_usd_cents`         |
| Reserved unit     | `reserved_usd_cents` bigint                                    | `customer.reserved_usd_cents`        |
| Top-up            | Stripe Checkout → webhook → `service/billing.creditTopup`      | `runtime/stripeWebhook` (later plan) |
| Hard stop         | Reject at `balance − reserved < est_cost`                      | `service/billing.reserve`            |
| Refund on failure | Full reservation returned via `refund` or partial via `commit` | `service/billing`                    |

### Reserve / commit / refund

- `service/billing.reserve({ customerId, workId, estCostCents })` — decrements available, throws `BalanceInsufficientError` if short.
- `service/billing.commit({ reservationId, actualCostCents })` — charges `min(actual, reserved)`, refunds the delta.
- `service/billing.refund(reservationId)` — returns the entire reservation; balance unchanged (nothing was ever debited).

Same row-lock invariant as free tier.

## Tier upgrade flow

A free customer who sends their first USD top-up is upgraded in-place:

1. `service/billing.creditTopup` runs under `FOR UPDATE`; on success it credits `balance_usd_cents` and (in a follow-on plan) flips `tier='prepaid'` atomically.
2. Remaining quota tokens are discarded — prepaid customers bill in USD and any leftover free-tier allowance is no longer meaningful.
3. Rate limits relax to the prepaid tier's policy on the next request.

In 0003 the billing primitives already support both tiers; the in-place upgrade transition ships with the Stripe webhook exec-plan (0010).

## Anti-goals

- **No mixed-currency customers.** A customer is free XOR prepaid. Mixing USD balance with token quota is a product- and UX-level simplification we do not intend to break.
- **No retroactive quota/balance changes.** Adjusting a customer's balance outside `creditTopup` / refund paths requires a dedicated ops tool; it does not happen silently in request handling.
- **Wei never leaks.** All customer-visible fields denominate in USD or tokens. ETH-equivalent cost of a request is computed internally for reconciliation and reporting, never surfaced.

## Related code

- Schema: `src/repo/schema.ts` — `customer`, `reservation`.
- Service: `src/service/billing/reservations.ts`, `src/service/billing/topups.ts`.
- Types: `src/types/customer.ts` — `CustomerTier`, `BalanceEntry`, `QuotaEntry`.
