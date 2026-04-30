---
id: 0033
slug: tooling-dependency-upgrades
title: Upgrade tooling and test dependencies
status: completed
owner: codex
opened: 2026-04-30
---

## Goal

Bring the repo's linting, TypeScript, Vitest, Testcontainers, and frontend browser-test tooling closer to current releases without changing the application runtime stack.

## Non-goals

- Upgrading Fastify or its plugins
- Upgrading Stripe, Drizzle, or Zod
- Refactoring product code unrelated to tool compatibility

## Approach

- [x] Upgrade root tooling dependencies and refresh the root lockfile.
- [x] Upgrade frontend test-tooling dependencies and refresh the frontend lockfile.
- [x] Fix compatibility issues introduced by the toolchain updates.
- [x] Re-run lint, typecheck, tests, UI build, and doc lint before landing.

## Decisions log

### 2026-04-30 — Keep runtime dependency majors out of this pass

Reason: The repo has active CI failures and stale tooling, but the runtime stack carries broader compatibility risk. Splitting the work keeps this pass bounded and easier to verify.

### 2026-04-30 — Revert Vitest 4 after validating the upgrade path

Reason: Vitest 4 made the existing suite pass functionally, but it changed coverage accounting enough to break the enforced global 75% branch threshold. That is a legitimate compatibility concern for this repo, so the safe move in this pass is to keep the rest of the tooling upgrades and leave Vitest on the last known-good major.

## Open questions

- Whether the Vitest 4 / jsdom 29 combination requires source or test harness changes beyond config updates.

## Artifacts produced

- Root dependency updates in `package.json` / `package-lock.json`
- Frontend dependency updates in `frontend/portal/package.json`, `frontend/admin/package.json`, and `frontend/package-lock.json`
- Test hardening in `packages/livepeer-openai-gateway/src/runtime/http/admin/pricing.test.ts`
- Test hardening in `packages/livepeer-openai-gateway/src/service/pricing/rateCard.test.ts`
