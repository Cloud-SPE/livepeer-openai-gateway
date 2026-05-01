---
id: 0033
slug: v3-route-first-payment-cutover
title: v3 route-first payment cutover
status: completed
owner: agent
opened: 2026-05-01
closed: 2026-05-01
depends-on: 0032-v3-0-1-shell-realignment
---

## Goal

Cut this shell repo over to the actual v3 runtime contract: resolver
selection returns one route keyed by `(capability, offering, tier)`,
the bridge computes ticket face value from the resolver wholesale
price, the sender daemon creates payments directly from
`(face_value, recipient)`, and workers are no longer probed via
historical `/capabilities`, `/quote`, or `/quotes` endpoints.

## Non-goals

- Do not preserve worker `/quote`, `/quotes`, or `/capabilities`
  compatibility in this shell.
- Do not preserve bridge-side session caching or quote-refresh loops.
- Do not add multi-registry merge behavior. One resolver deployment
  still targets one registry contract.
- Do not reintroduce legacy resolver fallback for unsigned or
  manifest-missing entries.

## Approach

- [x] Add shell-local v3 providers for `service-registry-daemon` and
      `payment-daemon` using the current upstream RPC contracts rather
      than the stale published engine package surface.
- [x] Replace the shell composition root so it no longer wires
      `QuoteCache`, `quoteRefresher`, or session caching.
- [x] Add shell-local route selection + payment helpers that:
      `Resolver.Select(capability, offering, tier)` → compute
      `face_value_wei` → `CreatePayment(face_value, recipient)`.
- [x] Replace the shell's HTTP route bindings with local v3-native
      dispatchers/wrappers for chat, streaming chat, embeddings,
      images, speech, and transcriptions.
- [x] Keep admin and metrics behavior coherent under the new runtime:
      registry probe reflects resolver-backed capabilities, and node
      health no longer depends on quote polling.
- [x] Update env, compose, and operator docs to remove
      `BRIDGE_ETH_ADDRESS` and historical worker quote terminology.
- [x] Rewrite route/integration tests so fake workers expose the v3
      contract (`/health`, workload route, `/registry/offerings`,
      sender-daemon-side ticket params via the daemon) instead of
      `/quotes`.
- [x] Run `fmt`, `lint`, `typecheck`, `doc-lint`, `test`, and `build`.

## Decisions log

### 2026-05-01 — Carry the v3 runtime cut in the shell until the published engine package catches up

Reason: the published `@cloudspe/livepeer-openai-gateway-core@3.0.0`
package still encodes the old quote/session contract, while the local
worker, resolver, and payment-daemon repos already implement the v3
route-first contract. This shell therefore needs local providers and
route bindings now instead of waiting for a package release.

### 2026-05-01 — Drop bridge-side quote/session state entirely

Reason: worker `/quote`, `/quotes`, and `/capabilities` are deleted in
v3. Keeping `QuoteCache`, `quoteRefresher`, or session-cache shims in
the bridge would only preserve dead protocol paths and continue to mark
healthy v3 workers as broken.

### 2026-05-01 — Keep resolver selection authoritative

Reason: the resolver now returns one selected route with wholesale
price and recipient identity. The bridge may still track circuit state
for observability, but route discovery itself is resolver-owned and no
longer performed by bridge-side candidate filtering.

## Open questions

- Should the bridge perform any pre-dispatch worker liveness probe in
  v3, or should the first paid workload request be the only health
  signal that matters?
- If the resolver repeatedly returns a route whose worker is currently
  failing locally, should the bridge retry `Select(...)` immediately or
  surface the failure directly and rely on resolver-side health?

## Artifacts produced

- `docs/exec-plans/active/0033-v3-route-first-payment-cutover.md`
- `packages/livepeer-openai-gateway/src/config/payerDaemon.ts`
- `packages/livepeer-openai-gateway/src/providers/payerDaemon.ts`
- `packages/livepeer-openai-gateway/src/providers/payerDaemon/grpc.ts`
- `packages/livepeer-openai-gateway/src/providers/serviceRegistry.ts`
- `packages/livepeer-openai-gateway/src/providers/serviceRegistry/grpc.ts`
- `packages/livepeer-openai-gateway/src/service/routing/selectRoute.ts`
- `packages/livepeer-openai-gateway/src/service/payments/createPayment.ts`
- `packages/livepeer-openai-gateway/src/dispatch/*.ts`
- `packages/livepeer-openai-gateway/src/runtime/http/{chat,embeddings,images,audio}/`
- `packages/livepeer-openai-gateway/src/runtime/http/testSupport/v3Harness.ts`

## Progress log

### 2026-05-01 — Landed shell-local v3 runtime composition

- Replaced stale engine-package quote/session bootstrap with shell-local
  resolver and payer-daemon providers that speak the current gRPC
  contracts.
- Rebound chat, streaming, embeddings, images, speech, and transcription
  routes to local v3-native dispatchers.
- Removed `BRIDGE_ETH_ADDRESS` from env/compose/docs because payment
  creation now depends on resolver-selected recipient + computed face
  value rather than bridge-side session bootstrapping.

### 2026-05-01 — Validation complete

- `npm run fmt` passed
- `npm run lint` passed with existing file-size warnings only
- `npm run typecheck` passed
- `npm run doc-lint` passed
- `npm test` passed
- `npm run build` passed

## Outcome

This shell now follows the actual v3 runtime contract:

- discovery and routing come from `Resolver.Select(...)`
- worker `/quotes` and `/capabilities` are no longer part of bridge
  correctness
- payment creation uses resolver wholesale pricing plus direct
  `CreatePayment(face_value, recipient)` sender-daemon calls
- tests, docs, env, and compose now match that runtime
