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

The bulk of plan 0031's work landed in the **`@cloudspe/livepeer-openai-gateway-core`**
upstream package's v3.0.0 cut — proto regen, `Model`→`Offering`
rename, and `SelectRequest.model` → `.offering` all sit there. This
repo (the bridge shell) consumes the package; the bridge's
consumer-facing `SelectQuery.model` shape was preserved in gateway-core
v3 for backwards compat, so the bridge code keeps working unchanged.

**Reality-check** (2026-04-29): the original plan claimed the bridge
had a *Postgres-stored wholesale rate card* to replace with manifest
reads. Audit shows otherwise — the bridge has only a customer-facing
USD rate card (`src/service/pricing/rateCard.ts`); wholesale prices
already flow through gateway-core's `nodeClient.getQuote` via the
worker's HTTP `/quote` response (`model_prices[].price_per_work_unit_wei`).
There is no wholesale-rate Postgres table to replace. The "manifest
pricing adoption" header in plan 0031 was speculative and
inapplicable.

What's actually needed in this repo for v3 alignment:

- [x] Proto regen + rename — landed in gateway-core v3.0.0 (commit
      `9e0bd8b`, tag pushed). Bridge inherits.
- [x] `SelectRequest` call sites — gateway-core's `SelectQuery.model`
      input parameter preserved as backwards-compat alias mapping to
      `offering` on the wire. No bridge code change required.
- [x] Customer-facing USD rate card — explicitly kept untouched, by
      design.
- [ ] Bump `@cloudspe/livepeer-openai-gateway-core` dep from `^0.2.0`
      to `^3.0.0` in `packages/livepeer-openai-gateway/package.json`
      once gateway-core is published to the `@cloudspe` npm scope
      (operator-driven; requires npm credentials).
- [ ] Until npm publish lands, the bridge keeps consuming v0.2.0 from
      the registry — and continues to pass all 264 tests because the
      gateway-core v3 consumer API is wire-compatible with v0.2.0
      (verified via `npm test --workspace=livepeer-openai-gateway`
      2026-04-29).
- [ ] After the dep bump, tag this repo `v3.0.0`.

## Postgres wholesale rate card (was: §Approach.4) — STRUCK

The plan mistakenly claimed `src/service/pricing/rateCard.ts` had a
wholesale-tier read path. Audit on 2026-04-29 confirmed the rate card
is purely customer-facing (USD). The wholesale wire path already lives
in `@cloudspe/livepeer-openai-gateway-core`'s `nodeClient.getQuote`,
which reads `price_per_work_unit_wei` directly from each worker's
`/quote` HTTP response. No bridge-side change needed for "manifest
pricing adoption."

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
