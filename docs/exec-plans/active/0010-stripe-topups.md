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

_(empty)_

## Open questions

- Minimum top-up amount: $5? $10? Balance between friction and per-tx cost.
- Maximum top-up amount: cap for risk/fraud reasons? $500 for v1.
- Currency: USD only per `v1 scope`. Multi-currency is a v2 item.
- Email receipts: rely on Stripe's or send our own? Stripe's is sufficient for v1.

## Artifacts produced

_(to be populated on completion)_
