---
id: 0001
slug: repo-scaffold
title: Stand up initial repository scaffolding
status: active
owner: human
opened: 2026-04-24
---

## Goal

Lay down the full scaffolding for `openai-livepeer-bridge` before any implementation code is written: directory structure, layer placeholders, lints, CI, initial design-docs, and tooling. The repo should be ready for the next exec-plan (`0002-types-and-zod`) to start writing code inside a well-defined frame.

## Non-goals

- No domain types or Zod schemas yet. That is `0002-types-and-zod`.
- No CustomerLedger schema. That is `0003-customerledger`.
- No auth layer. That is `0004-auth-layer`.
- No NodeBook. That is `0005-nodebook`.
- No PayerDaemon client. That is `0006-payer-client`.
- No OpenAI endpoints. That is `0007-chat-completions-nonstreaming` and `0008-chat-completions-streaming`.

## Approach

- [x] Create root files: AGENTS.md, DESIGN.md, PLANS.md, PRODUCT_SENSE.md, README.md, .gitignore, .nvmrc, .prettierrc.json
- [x] Create `docs/` structure with design-docs, exec-plans (active/completed), product-specs, generated, references
- [x] Author initial design-docs: index, core-beliefs, architecture
- [x] Seed `tech-debt-tracker.md` and `product-specs/index.md`
- [x] Create source layer directories (`src/{types,config,providers,repo,service,runtime,ui}/`) with `.gitkeep` where empty
- [x] Create `lint/` directory with README describing planned lints
- [x] Initialize `package.json` for Node 20 + TypeScript 5.4
- [x] `tsconfig.json` with strict mode
- [x] `eslint.config.js` (flat config) with placeholder custom rules
- [x] GitHub Actions workflows (lint, test, typecheck)
- [ ] First commit: "Initial scaffolding"
- [ ] Follow-up exec-plans opened as stubs: 0002 through 0012
- [ ] Custom ESLint plugin for layer-check (stub in place; full impl in separate exec-plan)
- [ ] Test runner wired (Vitest leaning; confirm in 0002)

## Decisions log

### 2026-04-24 — TypeScript/Node over Go for the bridge
Reason: OpenAI SDK is TS-first, Stripe SDK is first-class in TS, SSE proxying is idiomatic in Node, `tiktoken` has well-maintained JS bindings. Go would be defensible for consistency with the payment daemon; chose TS for ecosystem.

### 2026-04-24 — ESLint 9 flat config over legacy `.eslintrc`
Reason: flat config is the current standard; the custom plugin we'll author is simpler to wire in.

### 2026-04-24 — `docs/references/` plural
Already plural in this repo; harmonized the library repo to match.

## Open questions

- **Module path / npm name.** Placeholder is `openai-livepeer-bridge`. Will we publish to npm, or deploy as a container only? Affects `package.json#name` and scope.
- **Test runner.** Vitest (fast, ESM-native, TS out of the box) or Node's built-in test runner? Lean Vitest; decide in 0002.
- **Postgres migration tooling.** `node-pg-migrate`, `drizzle-kit`, `knex`, or plain SQL files? Decide in 0003 when we first need migrations.
- **Zod version.** 3.x is stable; 4 is in alpha/beta. Stick with 3 for v1.
- **License.** Copy MIT? Pick at first release.

## Artifacts produced

- Initial commit — directory tree, root docs, design-docs, first exec-plan
- Follow-on exec-plans opened as stubs (0002–0012)
