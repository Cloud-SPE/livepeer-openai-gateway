---
id: 0002
slug: types-and-zod
title: Domain types and Zod schemas
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Author every domain type needed for the bridge, expressed as Zod schemas in `src/types/`. Decide on test runner and migration tool. No implementation code outside `types/` yet — this plan establishes the boundary every later plan validates against.

## Non-goals

- No handlers, no Postgres, no Stripe, no Redis. Those come in later plans.
- No generated gRPC types — those appear when the payment daemon's `livepeer.payments.v1` proto lands (library repo's 0003).

## Approach

- [ ] Customer types: `Customer`, `Tier` (`free | prepaid`), `ApiKey`, `BalanceEntry`, `QuotaEntry`
- [ ] Node types: `NodeConfig`, `NodeState`, `Quote`, `HealthStatus`
- [ ] Pricing types: `Tier` (pricing tier: `Starter | Standard | Pro`), `RateCard`, `ModelTierMap`
- [ ] OpenAI wire types: `ChatCompletionRequest`, `ChatCompletionResponse`, `ChatCompletionChunk`, `Usage`, `Message`, `StreamOptions`
- [ ] Payment types: `WorkID` (opaque string), `PaymentBlob` (bytes), `LedgerDebit`, `LedgerRefund`
- [ ] Error shapes: consistent error envelope for HTTP + gRPC boundaries
- [ ] Choose test runner (decision)
- [ ] Choose Postgres migration tool (decision)
- [ ] Wire `vitest` (or chosen runner) configs, sample test
- [ ] Lint: every type in `src/types/` exports a Zod schema AND an inferred TS type (`z.infer<typeof X>`)

## Decisions log

_(empty)_

## Open questions

- Test runner: Vitest (fast, ESM-native, TS out of the box) vs Node built-in test runner. Leaning Vitest.
- Postgres migration tool: `node-pg-migrate` (vanilla, battle-tested), `drizzle-kit` (type-safe schemas + queries), `knex` (query builder). Drizzle aligns well with Zod type-first approach.
- Zod version: 3.x (stable) vs 4 (beta). Stick with 3 for v1.
- How strict is `noUncheckedIndexedAccess` for our schemas? Already on in `tsconfig.json`.

## Artifacts produced

_(to be populated on completion)_
