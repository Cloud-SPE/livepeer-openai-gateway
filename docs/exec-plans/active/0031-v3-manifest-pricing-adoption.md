---
id: 0031
slug: v3-manifest-pricing-adoption
title: v3.0.0 — proto regen, offerings rename, manifest-priced wholesale (Postgres rate-card → manifest read)
status: active
owner: agent
opened: 2026-04-29
depends-on: livepeer-network-suite plan 0003 §G (livepeer-openai-gateway row)
---

## Goal

Bring the openai-livepeer-bridge (this monorepo: `livepeer-openai-gateway`
+ `livepeer-gateway-core` packages) into the v3.0.0 contract:
regenerate resolver proto stubs against modules v3.0.0, rename
`models` → `offerings` references in TypeScript, and replace the
Postgres-stored wholesale rate-card reads in `src/service/pricing/`
with manifest-priced reads off
`offerings[i].pricePerWorkUnitWei` from the resolver `Select`
response. The customer-facing USD rate card stays as the *retail*
layer — the change is strictly to the *wholesale* input that drives
routing decisions.

## Non-goals

- No customer-facing pricing changes. The USD rate card and admin SPA
  surfaces shipped in plan 0030 stay intact.
- No retail-margin policy changes.
- No Stripe-side changes.
- No bridge-side scrape of `/registry/offerings` — the bridge consumes
  the resolver socket only; orch-side roster building lives in
  livepeer-orch-coordinator.

## Approach

- [ ] Regenerate resolver proto stubs against modules v3.0.0 (run the
      `buf.gen.registry.yaml`-equivalent under `packages/livepeer-openai-gateway/`).
- [ ] Rename `models` → `offerings` and `Model` → `Offering` in
      `packages/livepeer-openai-gateway/src/main.ts` and the
      gateway-core resolver client under
      `packages/livepeer-gateway-core/src/`.
- [ ] Update the `SelectRequest` call sites — `model` parameter →
      `offering` per modules v3.0.0 proto rename.
- [ ] Replace the Postgres wholesale-rate read in
      `packages/livepeer-openai-gateway/src/service/pricing/rateCard.ts`
      (the `V1_RATE_CARD` / wholesale-tier lookup path) with a read of
      `offerings[i].pricePerWorkUnitWei` from the resolver `Select`
      response.
- [ ] Workers with empty / absent offering price are skipped
      (fail-closed) — same pattern as the vtuber-gateway. No "free
      tier" semantics on missing wholesale price.
- [ ] Keep the customer-facing USD rate card read paths
      (`packages/livepeer-openai-gateway/src/service/pricing/rateCard.ts`
      retail tier resolution) untouched — retail margin remains
      bridge-controlled.
- [ ] Update `DESIGN.md` and `docs/design-docs/pricing-model.md`:
      "customer pricing remains bridge-controlled USD rate card; orch
      wholesale pricing is read from manifest
      `offerings[].pricePerWorkUnitWei` and used as the routing-decision
      input."
- [ ] Update tests in
      `packages/livepeer-openai-gateway/src/service/pricing/rateCard.test.ts`
      and any resolver-mocked tests to drive wholesale price from the
      manifest, not from a Postgres fixture.
- [ ] Smoke: route a chat completion through a v3.0.0
      service-registry-daemon resolver socket and confirm the
      wholesale price logged in the audit trail matches the
      manifest's `offerings[].pricePerWorkUnitWei`, not the Postgres
      column.
- [ ] Tag `v3.0.0`.

## Decisions log

## Open questions

- **Modules-project version tag** — assume `v3.0.0`; confirm with
  modules-project plan 0004 before regenerating proto stubs.
- **Manifest `schema_version` integer** — CONFIRMED `3` (operator answered 2026-04-29).
- **Daemon image pinning** — CONFIRMED hardcoded `v3.0.0` (every component lands at v3.0.0 in this wave; no tech-debt entry needed).
- Does the wholesale-rate Postgres column / table get dropped
  outright in the same cut, or kept as a read-shadow for one
  release for operator-side audit comparison? Default: drop it; the
  manifest is now the single source of truth.
- Single plan covering both `livepeer-openai-gateway` and
  `livepeer-gateway-core` packages — confirmed because there is one
  `PLANS.md` at the monorepo root and no per-package
  `docs/exec-plans/` tree.

## Artifacts produced
