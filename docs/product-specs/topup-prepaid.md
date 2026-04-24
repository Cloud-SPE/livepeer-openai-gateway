---
title: Prepaid top-up — customer flow
status: accepted
last-reviewed: 2026-04-24
---

# Prepaid top-up

What the customer sees when they add USD to their balance. Implementation lives in `docs/design-docs/stripe-integration.md`; this doc captures the customer-facing surface.

## Happy path

1. Customer calls `POST /v1/billing/topup` with `{ amount_usd_cents: <int> }` and their API key.
2. Bridge returns `{ url, session_id }`.
3. Customer follows `url` → lands on Stripe Checkout.
4. Customer enters card info; Stripe collects.
5. Stripe redirects to `STRIPE_SUCCESS_URL` (operator-configured).
6. Asynchronously, Stripe calls bridge's webhook → bridge credits balance.
7. Customer's next API request sees the new balance.

Typical latency between step 4 and step 6: a few seconds. The SDK retries mild transient failures; if the customer sees "success" on Stripe's page but their balance hasn't updated, the webhook is in flight.

## Amount bounds (v1)

- Minimum: **$5** (500 cents).
- Maximum: **$500** (50_000 cents).
- Multiple top-ups per month are allowed — no cap on cumulative.

Bounds are operator-tunable via `STRIPE_PRICE_MIN_CENTS` / `STRIPE_PRICE_MAX_CENTS`. Out-of-range amounts return 400 with `invalid_request_error`.

## Tier upgrade on first top-up

A `free`-tier customer who tops up for the first time is **upgraded to `prepaid` atomically with the credit**. Their free-tier quota becomes irrelevant (prepaid customers bill in USD) but historical quota counters are preserved for audit. Rate-limit policy flips to `prepaid-default` (60 req/min, 10_000 req/day, 10 concurrent).

Subsequent top-ups only credit the balance.

## Disputes and refunds

- **Disputes** (customer-initiated chargebacks): handled server-side by setting `topup.disputed_at`. Balance is **not** clawed back automatically. Operator decides via admin tooling.
- **Refunds**: v1 is a manual ops process. An operator inspects Stripe + our ledger, issues a Stripe refund, and (in 0012) uses the admin endpoint to reverse the ledger credit.
- **Email receipts**: sent by Stripe (standard payment-confirmation email). No custom bridge email in v1.

## Edge cases

| Scenario                             | What the customer sees                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Card declined at Stripe              | Stripe's UI shows the error; no bridge-side change. Customer can retry.      |
| Customer closes the tab mid-checkout | No balance change; they can re-call `POST /v1/billing/topup`.                |
| Webhook delayed                      | Balance updates when webhook fires. Next request sees it.                    |
| Duplicate webhook retry              | Idempotent (event_id uniqueness). No double-credit.                          |
| Zero-balance mid-request             | Reservation fails with 402 insufficient_quota. Customer tops up and retries. |

## Not in v1

- Auto-reload at threshold.
- API-initiated refunds.
- Custom-branded email receipts.
- Multi-currency (USD only).
- Invoicing / NET terms.
