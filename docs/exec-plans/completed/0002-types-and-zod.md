---
id: 0002
slug: types-and-zod
title: Domain types and Zod schemas
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Author every domain type needed for the bridge, expressed as Zod schemas in `src/types/`. Decide on test runner and migration tool. No implementation code outside `types/` yet — this plan establishes the boundary every later plan validates against.

## Non-goals

- No handlers, no Postgres, no Stripe, no Redis. Those come in later plans.
- No generated gRPC types — those appear when the payment daemon's `livepeer.payments.v1` proto lands (library repo's 0003).

## Approach

- [x] Customer types: `Customer`, `CustomerTier` (`free | prepaid`), `ApiKey`, `BalanceEntry`, `QuotaEntry`
- [x] Node types: `NodeConfig`, `NodeState`, `Quote`, `HealthStatus`
- [x] Pricing types: `PricingTier` (`starter | standard | pro`), `RateCard`, `ModelTierMap`
- [x] OpenAI wire types: `ChatCompletionRequest`, `ChatCompletionResponse`, `ChatCompletionChunk`, `Usage`, `Message`, `StreamOptions`
- [x] Payment types: `WorkId` (opaque branded string), `PaymentBlob` (bytes), `LedgerDebit`, `LedgerRefund`
- [x] Error shapes: consistent error envelope for HTTP + gRPC boundaries
- [x] Choose test runner (decision: Vitest)
- [x] Choose Postgres migration tool (deferred to 0003; leaning Drizzle-kit)
- [x] Wire `vitest` configs + sample test (coverage gate ≥ 75% enforced by `npm test`)
- [x] Lint: every type in `src/types/` exports a Zod schema AND an inferred TS type (`z.infer<typeof X>`) — mechanical enforcement delegated to the layer-check / ESLint plugin exec-plan (tracked in tech-debt-tracker.md); the convention is upheld by every file in this plan.

## Decisions log

### 2026-04-24 — Vitest as the test runner

Reason: ESM + TypeScript out of the box matches the existing `tsconfig.json` (`module: NodeNext`, `strict: true`) with zero extra build plumbing. Node's built-in runner would avoid a devDep but forces hand-rolled TS transforms and weaker watch/inspector ergonomics. Fast watch mode matters because we expect to author a lot of schema-level unit tests as each domain lands.

### 2026-04-24 — Zod 3.x for v1

Reason: 3.x is the stable line; 4 is still beta at the time of scaffolding. Stability of the Zod API is a cross-cutting invariant (`core-beliefs.md#4`) — we will not chase a beta here.

### 2026-04-24 — Migration tool decision deferred to 0003

Reason: 0002 does not yet touch Postgres. Locking the tool before `repo/` exists risks over-committing before the CustomerLedger schema is fully specified. Leaning Drizzle-kit because its Zod integration compounds with core-belief #4 ("Zod at every boundary"), but the call lives in `0003-customerledger`.

### 2026-04-24 — Coverage floor ≥ 75%, strictly enforced by `npm test`

Reason: Operator directive at scaffold time. `npm test` runs `vitest run --coverage` and fails if lines/branches/functions/statements fall below 75%. Codified as core belief #11 and AGENTS.md invariant #7 so it applies to every subsequent plan.

## Open questions

- Postgres migration tool: decided in 0003 (see decisions log above). Drizzle-kit is the leading candidate; `node-pg-migrate` is the safe fallback if schema-as-code turns out to be a poor fit.
- How strict is `noUncheckedIndexedAccess` for our schemas? Already on in `tsconfig.json` — will surface if Zod's inferred types produce awkward call sites.

## Artifacts produced

- `src/types/{customer,node,pricing,openai,payment,error,index}.ts` — all domain Zod schemas + inferred types
- `src/types/types.test.ts` — boundary tests (parse/reject) covering every schema file (100% coverage at authoring)
- `vitest.config.ts` — Vitest config with v8 coverage and 75% threshold across lines/branches/functions/statements
- Core belief #11 + AGENTS.md invariant #7 — codifies the coverage gate as a repo-wide rule
