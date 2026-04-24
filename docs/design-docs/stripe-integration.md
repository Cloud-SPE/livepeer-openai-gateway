---
title: Stripe integration (Checkout top-ups + webhook)
status: accepted
last-reviewed: 2026-04-24
---

# Stripe integration

How customer USD flows into `customer.balance_usd_cents`. Stripe Checkout for the UI, Stripe webhook for the credit event. Complements `tiers.md` (which owns the commit/refund side).

## Flow

```
customer
  │  POST /v1/billing/topup        { amount_usd_cents }
  ▼
bridge
  │  creates Stripe Checkout Session
  │    - client_reference_id = customer.id
  │    - metadata.customer_id = customer.id
  │    - line_item price_data: USD / unit_amount / "API Credits"
  │  returns { url, session_id }
  ▼
customer
  │  redirected to Stripe Checkout, pays card
  ▼
Stripe
  │  calls webhook: POST /v1/stripe/webhook  (checkout.session.completed)
  │    Header: Stripe-Signature
  │    Raw body required for signature verification
  ▼
bridge
  │  verify signature → parse event
  │  INSERT INTO stripe_webhook_event (event_id) ON CONFLICT DO NOTHING
  │    (returns false ⇒ duplicate retry ⇒ 200 OK, skip)
  │  service/billing.creditTopup (one tx):
  │    - SELECT customer FOR UPDATE
  │    - INSERT INTO topup
  │    - UPDATE customer.balance_usd_cents += amount
  │    - if customer.tier == 'free': UPDATE tier='prepaid', rate_limit_tier='prepaid-default'
  ▼
bridge → 200 OK
```

## Endpoints

### `POST /v1/billing/topup`

- Auth: required (Bearer API key; `req.caller` attached by `authPreHandler`).
- Body: `{ amount_usd_cents: integer }`.
- Bounds: `STRIPE_PRICE_MIN_CENTS ≤ amount ≤ STRIPE_PRICE_MAX_CENTS` (defaults 500 / 50_000).
- Response: `{ url: string, session_id: string }` (200) — the `url` redirects the customer to Stripe.
- Errors: 400 invalid_request_error (amount out of range, missing field); 401 invalid_api_key; 5xx on Stripe SDK failure.

### `POST /v1/stripe/webhook`

- Auth: none. Authentication is via `stripe-signature` header + `STRIPE_WEBHOOK_SECRET`.
- Body: raw. Captured by `fastify-raw-body` (`config: { rawBody: true }` on this route only).
- Response: 200 on success, 200+`{status:'duplicate_ignored'}` on replay, 400 on signature failure, 500 on event-handling failure.

## Handled events

| Event type                   | Action                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `checkout.session.completed` | `creditTopup` (atomic credit + tier upgrade)                                   |
| `charge.dispute.created`     | `markTopupDisputed` (sets `topup.disputed_at`; balance untouched)              |
| Anything else                | 200 + logged at INFO (Stripe retries on 4xx; we must not 4xx on unknown types) |

## Tier upgrade policy

First top-up from a `free`-tier customer atomically:

- Credits balance by `amount_usd_cents`.
- Flips `customer.tier` from `'free'` to `'prepaid'`.
- Flips `customer.rate_limit_tier` from whatever to `'prepaid-default'`.
- Leaves quota columns untouched (historical audit; prepaid customers don't consume quota).

Subsequent top-ups (customer already prepaid): only the balance increment.

All inside one transaction under a `SELECT FOR UPDATE` on the customer row — a crash partway through leaves either fully-applied or fully-rolled-back state.

## Idempotency

`stripe_webhook_event` table. `event_id` PK. Every webhook hit does `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id`. If a row returns, we process; otherwise we ack with 200 `{status:'duplicate_ignored'}`. Stripe will not retry after a 2xx — this keeps double-crediting mathematically impossible even across bridge crashes and Stripe retry storms.

## Dispute handling

`charge.dispute.created` sets `topup.disputed_at` but does **not** reverse the credit automatically. Disputed-flag is a signal for operators to:

1. Investigate the chargeback via Stripe dashboard.
2. Manually adjust the customer balance (admin endpoint — lands in 0012).
3. Optionally close or suspend the customer account.

Automated refund-on-dispute is deliberate tech-debt: we'd rather let a human decide whether to claw back a balance already partially spent on inference.

## Config

Loaded from env at startup (`src/config/stripe.ts`, Zod-validated):

```
STRIPE_SECRET_KEY            required — Stripe API key
STRIPE_WEBHOOK_SECRET        required — webhook signing secret
STRIPE_SUCCESS_URL           required — redirect after successful payment
STRIPE_CANCEL_URL            required — redirect if customer cancels
STRIPE_PRICE_MIN_CENTS       default 500   (integer cents)
STRIPE_PRICE_MAX_CENTS       default 50000 (integer cents)
```

## Webhook raw-body plumbing

`fastify-raw-body` is registered on the Fastify instance with `global: false`; only routes that opt in via `config: { rawBody: true }` have their raw bytes captured. Registration must be awaited before any route is defined on the instance — without `await`, the preParsing hook doesn't attach in time. `createFastifyServer` is now async for this reason.

## Out of scope (tech-debt)

- Auto-reload (credit when balance crosses a low-water threshold) — v1.5.
- API-initiated refunds — requires operator tooling; lands with 0012.
- Our own email receipts — Stripe's receipts are sufficient for v1.
- `stripe_webhook_event` retention sweep — grows unboundedly until ops needs it archived.
