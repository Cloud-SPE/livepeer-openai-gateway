---
title: v3 runtime realignment
status: accepted
last-reviewed: 2026-04-30
---

# v3 runtime realignment

This note records the gap between the shell's current shipped runtime
and the suite-level v3.0.1 protocol now defined in the updated network,
gateway, and worker specs.

## Why this doc exists

The repo docs had drifted into an ambiguous state:

- some pages described the current shipped runtime
- some pages implied the newer v3.0.1 suite protocol was already live
- the actual dependency boundary lives outside this repo because the
  shell consumes `@cloudspe/livepeer-openai-gateway-core` from npm and
  talks to the external `payment-daemon` / `service-registry-daemon`
  repos over gRPC

This doc makes that boundary explicit.

## Current shipped runtime

Today this shell runs on the published
`@cloudspe/livepeer-openai-gateway-core@3.0.0` package and still uses
the engine's existing routing/payment path:

- bridge-local quote refresh and quote cache
- worker `/quote` and `/quotes` probes
- resolver selection input still named `model` in the consumer-facing
  interface
- payment bootstrap still coupled to quote-derived session/payment data

That is what the code in this repo currently wires in
[`packages/livepeer-openai-gateway/src/main.ts`](../../packages/livepeer-openai-gateway/src/main.ts).

## Suite v3.0.1 target runtime

The updated suite spec requires the follow-on runtime contract below:

1. Gateway calls `Resolver.Select(capability, offering, tier, geo, weight)`.
2. Resolver returns the selected worker URL, orch eth address, work unit,
   and manifest wholesale `price_per_work_unit_wei`.
3. Gateway computes `face_value` itself from wholesale price and the
   request's estimated max units.
4. Gateway calls `payment-daemon` sender mode:
   `CreatePayment(face_value, recipient)`.
5. Gateway calls the worker workload endpoint with the ticket header.
6. Worker validates the ticket via its local receiver-mode
   `payment-daemon` and reports `actual_units_used`.
7. Gateway commits customer billing from retail USD pricing only after
   the worker call succeeds.

Under that target contract:

- worker `/capabilities`, `/quote`, and `/quotes` are deleted
- `model` becomes `offering` across resolver-facing interfaces
- wholesale price becomes manifest/resolver-owned, not worker-quote-owned

## What is repo-local vs external

### External dependencies

These changes must land upstream before this shell can complete the
runtime cut cleanly:

- `livepeer-openai-gateway-core` removes quote-refreshing and adopts the
  new resolver/payment flow
- `payment-daemon` exposes and documents the sender/receiver contract the
  new flow depends on
- `payment-daemon` completes the `Model -> Offering` rename in its shared
  `worker.yaml` parsing

### Repo-local follow-ons

Once the external boundary is ready, this shell still needs:

- retail pricing schema migration toward
  `(capability, offering, tier) -> retail_usd_per_unit`
- optional request idempotency storage keyed by
  `(customer_id, idempotency_key)`
- doc and UX verification for hot-wallet degraded mode
- doc and behavior verification for suspend/cancel semantics

## Source of truth

The architectural source documents reviewed for this realignment live
outside the repo in the local spec workspace:

- `livepeer-network-spec-v3.md`
- `livepeer-openai-gateway-spec-v3.md`
- `livepeer-openai-gateway-core-spec-v3.md`
