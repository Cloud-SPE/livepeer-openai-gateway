---
id: 0032
slug: v3-0-1-shell-realignment
title: v3.0.1 shell realignment — docs sweep, external-boundary reset, and repo-local follow-ons
status: active
owner: agent
opened: 2026-04-30
depends-on: livepeer-openai-gateway-core v3.0.1 protocol realignment
---

## Goal

Bring this shell repo into an honest v3.0.1 state: update the repo's
docs and plans to match the new suite architecture, record the runtime
changes this shell still needs, and land any repo-local follow-ons that
do not require guessing across the external `livepeer-openai-gateway-core`
and `livepeer-modules` boundaries.

## Non-goals

- Do not patch `node_modules/` or vendor a fork of
  `@cloudspe/livepeer-openai-gateway-core` into this repo.
- Do not guess at new `payment-daemon` sender/receiver gRPC shapes that
  are not yet implemented in the upstream daemon repo.
- Do not claim the v3.0.1 runtime protocol cut is complete in this repo
  until the external engine/modules dependencies land.

## Approach

- [x] Archive `0031-v3-manifest-pricing-adoption.md` with a completed
      status and a clear note that the dependency bump/pin alignment work
      landed, while the deeper v3.0.1 runtime rewrite belongs to a new plan.
- [x] Sweep stale repo docs (`README.md`, `DESIGN.md`,
      `docs/design-docs/architecture.md`, deployment/ops docs as needed)
      so they stop claiming: - worker `/quote` and `/quotes` are part of the v3.0.1 contract - old engine versions (`0.1.x`, `0.2.0`) are current - `livepeer-payment-library` / `livepeer-modules-project` are the
      canonical names - the shell has no active exec-plans
- [x] Add a shell-local design note describing the runtime gap between
      the current installed engine and the v3.0.1 suite protocol:
      `Resolver.Select(capability, offering, tier)` +
      gateway-computed `face_value` + worker-reported `actual_units_used`.
- [x] Record the repo-local changes that remain once the external
      dependencies are ready: - retail pricing schema reshape to `(capability, offering, tier)` - optional request idempotency storage and header handling - hot-wallet degraded-mode UX verification - suspension / cancellation doc alignment
- [x] Land shell-local idempotency support: - persist `Idempotency-Key` rows in Postgres - replay completed JSON / binary responses on duplicate requests - reject unsafe current-runtime cases (streaming chat, multipart
      uploads) - delete failed 5xx attempts so callers can retry with the same key
- [x] Run validation on the doc sweep (`doc-lint`, targeted type/build
      checks if touched files require it).
- [x] Land shell-native retail pricing storage and admin/API surfaces: - persist retail prices as
      `(capability, offering, customer_tier[, price_kind])` - persist request-selector aliases that map current OpenAI request
      shapes to offerings - synthesize the installed engine's older rate-card snapshot from
      the `prepaid` retail view so the current runtime keeps working - switch the admin SPA pricing page to the shell-native retail
      model and document the compatibility boundary
- [x] Align bridge deployment docs/config with the single-target AI
      service-registry rollout: - confirm the modules resolver still
      exposes the same `ResolveByAddress` / `ListKnown` / `Select`
      consumer RPCs - keep registry targeting in deployment config, not
      bridge app logic - default local/prod deploy artifacts to the
      Arbitrum One AIServiceRegistry contract address

## Decisions log

### 2026-04-30 — Separate the doc sweep from the protocol rewrite

Reason: the v3.0.1 spec now clearly defines a new runtime contract
(`offering`, no `/quote`, gateway-computed `face_value`), but this repo
consumes the engine as an npm dependency. Rewriting protocol behavior in
this shell without coordinated upstream engine/modules changes would
produce a half-cut system and hide the real dependency boundary.

### 2026-04-30 — Ship idempotency at the shell boundary now

Reason: request idempotency is explicitly called out as a v3.0.1
future-proofing move and can be implemented entirely in this repo
without waiting for the engine/modules protocol cut. The current shell
can safely support replay for non-streaming JSON and binary responses,
while explicitly rejecting streaming chat and multipart uploads until
the runtime is redesigned.

### 2026-04-30 — Migrate shell pricing now, but keep a prepaid legacy adapter

Reason: the shell-owned pricing/admin model can move to the v3.0.1
`(capability, offering, customer_tier)` shape without waiting for the
upstream runtime cut, as long as this repo still synthesizes the older
engine rate-card snapshot from the `prepaid` rows. Chat remains a
special case while the installed engine still expects separate
input/output pricing and at most four distinct price pairs.

### 2026-05-01 — Keep AI registry selection in deployment config, not bridge app logic

Reason: `livepeer-modules-project/service-registry-daemon` still
exposes the same resolver consumer RPCs (`ResolveByAddress`,
`ListKnown`, `Select`), so this shell does not need app-layer changes to
understand AI registry entries. The integration point remains one
resolver socket; operators choose the target registry contract per
deployment. This repo therefore defaults resolver deploy artifacts to
the Arbitrum One AIServiceRegistry contract instead of adding
bridge-side registry branching.

## Open questions

- Which upstream `livepeer-openai-gateway-core` release removes the
  quote-refresh path and `model`-named resolver inputs from its public
  consumer surface?
- Which upstream `livepeer-openai-gateway-core` release consumes the
  already-landed `payment-daemon` sender contract
  `CreatePayment(face_value, recipient)` end to end?
- When the upstream runtime cut lands, how quickly should the legacy
  prepaid adapter be deleted after the shell switches to native
  offering-based pricing end to end?

## Artifacts produced

- `docs/exec-plans/active/0032-v3-0-1-shell-realignment.md`
- `packages/livepeer-openai-gateway/migrations/0003_idempotency_requests.sql`
- `packages/livepeer-openai-gateway/migrations/0004_retail_pricing.sql`
- `packages/livepeer-openai-gateway/src/repo/idempotency.ts`
- `packages/livepeer-openai-gateway/src/runtime/http/middleware/idempotency.ts`
- `.env.example`
- `compose.yaml`
- `compose.prod.yaml`
- `README.md`
- `docs/operations/deployment.md`
- `docs/operations/portainer-deploy.md`
