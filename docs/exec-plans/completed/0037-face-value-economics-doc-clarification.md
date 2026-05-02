---
id: 0037
slug: face-value-economics-doc-clarification
title: Clarify worker payment economics and face-value floors
status: completed
owner: agent
opened: 2026-05-01
closed: 2026-05-01
---

## Goal

Document the current v3 payment economics clearly enough that operators
can distinguish: published worker price, gateway-computed face value,
and receiver-side minimum acceptable ticket economics.

## Non-goals

- Do not change runtime pricing or payment behavior.
- Do not introduce a gateway-side `MIN_FACE_VALUE_WEI` default.
- Do not change worker or payment-daemon config in this repo.

## Approach

- [x] Update `pricing-model.md` so the face-value floor behavior is
      explicit, including the distinction between `price_per_work_unit`
      and receiver acceptance floors.
- [x] Update `payer-integration.md` to explain why `CreatePayment(...)`
      can still fail after route selection and request-shape validation.
- [x] Add deployment troubleshooting guidance for
      `ticketparamsfetcher: ticket params status 500`.
- [x] Record deferred profitability / wholesale guardrails in the tech
      debt tracker.
- [x] Run `npm run doc-lint`.

## Decisions log

### 2026-05-01 — Document the economics instead of masking them

Reason: the bridge can be made to "work" by clamping face value upward,
but that changes operator economics and can subsidize small requests.
The docs should explain the current contract honestly before any product
decision is made to smooth over it.

## Open questions

- None for this doc-only pass.

## Artifacts produced

- `docs/design-docs/pricing-model.md`
- `docs/design-docs/payer-integration.md`
- `docs/operations/deployment.md`
- `docs/exec-plans/tech-debt-tracker.md`
