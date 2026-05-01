---
id: 0036
slug: payer-createpayment-offering-alignment
title: Align bridge payer CreatePayment calls with capability/offering sender contract
status: completed
owner: agent
opened: 2026-05-01
closed: 2026-05-01
depends-on: livepeer-modules-project sender CreatePayment capability/offering rollout
---

## Goal

Update this bridge so its payer-daemon client and local payment service
match the newer sender contract from `livepeer-modules-project`: every
`CreatePayment` call must carry `capability` and `offering` in addition
to `face_value` and `recipient`, so worker `/v1/payment/ticket-params`
requests validate and paid requests can complete.

## Non-goals

- Do not change resolver selection semantics or pricing math.
- Do not modify worker-side ticket-params validation in this repo.
- Do not patch archived exec-plans.

## Approach

- [x] Rename the bridge payment-layer input from ambiguous `model` to
      `offering` where it crosses into payer-daemon calls.
- [x] Extend the local payer gRPC serializer to emit fields 3 and 4
      (`capability`, `offering`) for `CreatePaymentRequest`.
- [x] Update dispatch/payment call sites to pass the selected offering
      through the new payment input.
- [x] Refresh bridge docs that still describe the older
      `CreatePayment(face_value, recipient, capability, offering)`
      contract.
- [x] Add or update tests that lock the bridge-side input shape to the
      new sender contract and run targeted validation.

## Decisions log

### 2026-05-01 — Treat the payer input as offering-based in the bridge

Reason: route selection already speaks in `(capability, offering, tier)`
terms. Keeping the payer boundary named as `model` would preserve a
misleading shell-local abstraction even after the upstream sender daemon
correctly requires `offering`.

## Open questions

- None at the bridge layer once the updated `payment-daemon` sender
  contract is present locally.

## Artifacts produced

- `docs/exec-plans/completed/0036-payer-createpayment-offering-alignment.md`
- `packages/livepeer-openai-gateway/src/providers/payerDaemon.ts`
- `packages/livepeer-openai-gateway/src/providers/payerDaemon/grpc.ts`
- `packages/livepeer-openai-gateway/src/providers/payerDaemon/grpc.test.ts`
- `packages/livepeer-openai-gateway/src/providers/payerDaemon/metered.ts`
- `packages/livepeer-openai-gateway/src/service/payments/createPayment.ts`
- `packages/livepeer-openai-gateway/src/service/payments/createPayment.test.ts`
