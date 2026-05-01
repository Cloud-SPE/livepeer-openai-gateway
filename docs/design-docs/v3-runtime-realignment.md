---
title: v3 runtime realignment
status: accepted
last-reviewed: 2026-05-01
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

1. Gateway calls `Resolver.Select(capability, offering, tier, min_weight)`.
2. Resolver returns one selected route with worker URL, orch eth
   address, work unit, and manifest wholesale
   `price_per_work_unit_wei`.
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

The main remaining external dependency is the engine/runtime release
this shell consumes:

- `livepeer-openai-gateway-core` removes quote-refreshing and adopts the
  new resolver/payment flow

The `payment-daemon` sender contract revision is already landed upstream:

- sender mode now exposes `CreatePayment(face_value, recipient)`
- the shared `worker.yaml` `Model -> Offering` rename is already landed
- bridge-facing deployment docs in `livepeer-modules-project` now
  describe the v3 flow explicitly

For this repo, the remaining gap is consuming that shipped daemon
contract through an updated `@cloudspe/livepeer-openai-gateway-core`
release and then cutting the shell over to it.

### Repo-local follow-ons

Once the external boundary is ready, this shell still needs:

- retail pricing schema migration toward
  `(capability, offering, tier) -> retail_usd_per_unit`
- final route coverage for the complete OpenAI surface, including any
  engine-provided `/v1/images/edits` handler once upstream exists
- doc and UX verification for hot-wallet degraded mode
- doc and behavior verification for suspend/cancel semantics

Idempotency storage keyed by `(customer_id, idempotency_key)` is already
implemented in this repo for supported JSON POSTs. Current-runtime
limitations remain explicit: multipart requests and streaming chat are
not replayable and are rejected when `Idempotency-Key` is supplied.

## Source of truth

The architectural source documents reviewed for this realignment live
outside the repo in the local spec workspace:

- `livepeer-network-spec-v3.md`
- `livepeer-openai-gateway-spec-v3.md`
- `livepeer-openai-gateway-core-spec-v3.md`
