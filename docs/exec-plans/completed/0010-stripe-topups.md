---
id: 0010
slug: stripe-topups
title: Stripe Checkout top-ups + webhook
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement the prepaid top-up flow: customer redirects to Stripe Checkout, pays, gets redirected back, webhook credits CustomerLedger. Single "API Credits" product with customer-chosen amount. USD only. Stripe Tax enabled.

Depends on: `0003-customerledger` (topup records + credit operation).

## Non-goals

- No auto-reload. That's a v1.5 item.
- No invoicing or receipts beyond what Stripe emails.
- No refunds via API. Refunds are a manual ops process in v1 (documented in product-spec).

## Approach

- [ ] Stripe account config (product, prices, tax settings) documented in design-doc
- [ ] `providers/stripe` adapter
- [ ] `runtime/billing/topup.ts` handler: creates a Stripe Checkout Session with `client_reference_id = customer.id`, redirects
- [ ] Success / cancel redirect URLs
- [ ] `runtime/stripeWebhook/` handler: verifies signature, routes by event type
- [ ] Handle `checkout.session.completed` → create topup record → credit CustomerLedger → emit metric
- [ ] Handle `charge.dispute.created` → flag customer, mark topup for operator review
- [ ] Idempotency: webhook retries must not double-credit (Stripe event ID is primary key)
- [ ] First-topup tier upgrade: customer on free tier flips to prepaid atomically with the credit
- [ ] Tests: successful flow, webhook replay, signature failure, dispute path
- [ ] Author `docs/product-specs/topup-prepaid.md`

## Decisions log

### 2026-04-24 — SDK: official `stripe` npm package

Reason: Typed, maintained, first-class Checkout + webhook + dispute coverage. Alternatives (hand-rolled HTTP client) carry no upside for the shape of this integration.

### 2026-04-24 — Webhook raw body via `@fastify/raw-body`, scoped to the webhook route only

Reason: `stripe.webhooks.constructEvent` needs the exact bytes Stripe signed. Fastify's default JSON parser mutates the payload and breaks signature verification. `@fastify/raw-body` with `global: false` captures raw bytes for `/v1/stripe/webhook` without disturbing JSON parsing on `/v1/billing/topup` and `/v1/chat/completions`.

### 2026-04-24 — Idempotency via durable `stripe_webhook_event` table (DB, not Redis)

Reason: Stripe retries up to 3× over 72 h. DB idempotency with the event ID as the primary key gives durable auditability that survives Redis flushes and cache outages. `ON CONFLICT (event_id) DO NOTHING` in the same transaction as `creditTopup` makes duplicates a clean no-op. Redis with TTL would work but loses the audit trail.

### 2026-04-24 — Custom amount via Checkout `price_data`, not a pre-created Stripe Price

Reason: Customer chooses the amount; bridge builds the Checkout Session with `price_data: { currency: 'usd', unit_amount: cents, product_data: { name: 'API Credits' } }`. Keeps the Stripe dashboard free of product config; ops can swap to a branded Price later without changing our code beyond one call site.

### 2026-04-24 — Amount bounds: $5 min, $500 max (cents; env-overridable)

Reason: $5 keeps per-tx Stripe fees palatable; $500 caps single-transaction fraud/abuse blast radius. Customers can top up multiple times in quick succession. Env overrides (`STRIPE_PRICE_MIN_CENTS`, `STRIPE_PRICE_MAX_CENTS`) give ops a dial without a redeploy.

### 2026-04-24 — Atomic tier upgrade on first credit

Reason: `service/billing.creditTopup` already runs under a customer-row lock. Adding `if (customer.tier === 'free') set tier = 'prepaid'` keeps the upgrade atomic with the credit — no possibility of a half-upgraded customer after a crash. Quota columns are left intact (prepaid customers don't consume them; historical data preserved for audit).

### 2026-04-24 — Dispute handling: mark + operator review; no automatic refund

Reason: `charge.dispute.created` sets `topup.disputed_at`. Balance is left intact; refund decisions belong to a human. The operator-refund path lands in `0012-admin-endpoints`. This matches `v1 scope → Stripe setup → no automated refunds (manual ops, 30-day window)` in the architecture reference.

### 2026-04-24 — Webhook event scope: three handled types; the rest 200+log

Reason: v1 handles `checkout.session.completed` (credit + upgrade) and `charge.dispute.created` (flag). `payment_intent.payment_failed` is logged for observability but does not mutate state (the user saw the failure in Stripe's UI). All other events are acknowledged with 200 and logged at INFO — Stripe treats 4xx as retry signals, so we must not 4xx on events we don't recognize.

## Open questions

- Currency: USD only per `v1 scope`. Multi-currency is a v2+ item.
- Email receipts: rely on Stripe's default receipts for v1. Our own templated email comes with customer-comms work later.
- Webhook event retention: `stripe_webhook_event` grows unboundedly; a periodic purge/archival job is tracked in tech-debt.

## Artifacts produced

_(to be populated on completion)_
