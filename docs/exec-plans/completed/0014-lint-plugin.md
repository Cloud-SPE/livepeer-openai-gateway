---
id: 0014
slug: lint-plugin
title: Mechanical enforcement of the architectural lints (layer-check, cross-cutting, zod-at-boundary, secrets-in-logs, file-size, types-shape)
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Turn `lint/README.md`'s five "planned" lints plus the `src/types/` shape lint into actual mechanical enforcement. Today all six are convention-only — upheld by code review and honor-system comments in `eslint.config.js`. Ship them as real rules that fail `npm run lint` (and CI) on violation, with remediation instructions embedded in the error message.

In scope: the rules themselves + the test harness + CI wiring. Out of scope: the doc-lint / doc-gardener (separate plan) and the proto-drift CI check (tracked in its own tech-debt entry).

## Non-goals

- No new rules beyond the six listed below.
- No secret-scanning beyond log-call argument analysis — full-repo secret scanning is a separate tool (gitleaks-class).
- No auto-fix for the architectural rules. Fixing `service/billing` importing `pg` is a human-judgment call; the lint reports, the engineer decides.

## Rules to ship

Ordered by blast radius.

### 1. `layer-check`

Enforces the layered dependency stack from `docs/design-docs/architecture.md`:

```
types → config → repo → service → runtime → ui
```

Plus: `providers/` is reachable from every layer; nothing else is.

Violations the rule must catch:

- `service/routing` importing `@grpc/grpc-js` directly (must go through `providers/payerDaemon`).
- `service/billing` importing `service/routing` (no cross-domain imports inside `service/`).
- `repo/*` importing anything in `service/*` (`repo` is below `service`).
- `runtime/*` importing `repo/*` is allowed, but `repo/*` → `runtime/*` is not.
- Anything under `src/` importing from `dist/` or `node_modules` via relative path.

### 2. `no-cross-cutting-import`

Companion to `layer-check`: explicit allowlist of cross-cutting libraries that may **only** appear under `src/providers/`:

```
stripe, ioredis, pg, @grpc/*, tiktoken, viem, pino, fastify, fastify-raw-body, tiktoken
```

`ts-proto`-generated stubs are an exception by path (`src/providers/payerDaemon/gen/**`).

### 3. `zod-at-boundary`

Every Fastify route handler body and gRPC response-handler body must begin with a Zod `.parse()` or `.safeParse()` call on the incoming data before any other statement. Structural AST check.

Catches:

- A new `/v1/embeddings` handler that reads `req.body.model` without parsing.
- A provider callback that returns wire bytes into the service layer without schema validation.

### 4. `no-secrets-in-logs`

Scans log-call arguments (`console.log`, `console.warn`, `req.log.*`, `logger.*`) for identifiers or object-keys matching a denylist: `apiKey`, `api_key`, `stripeSecret`, `stripeSigningSecret`, `webhookSecret`, `passphrase`, `privateKey`, `keystore`, `ADMIN_TOKEN`, `API_KEY_PEPPER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

### 5. `file-size`

Warn at 400 lines, error at 600. Excludes `src/**/*.test.ts`, `src/**/gen/**`.

### 6. `src/types/` shape lint

Every file in `src/types/*.ts` (excluding `index.ts`) must export both:

- At least one `Schema`-suffixed value (a Zod schema), and
- At least one `z.infer<typeof X>`-typed export.

Convention is currently upheld by every file; mechanical enforcement prevents drift.

## Approach

1. **Spike: Biome vs ESLint for the custom-rule shape (day 1).**
   Write throwaway versions of rules 1 (`layer-check`), 3 (`zod-at-boundary`), and 6 (`src/types/` shape) in both Biome GritQL plugins and a `typescript-eslint` plugin. Measure: can each tool express the rule cleanly? What does the error message look like? How much boilerplate per rule? Decide the toolchain from spike results (see "Decision point" below).

2. **Build the chosen plugin skeleton.**
   If ESLint: `@typescript-eslint/utils` RuleTester + a local plugin at `lint/eslint-plugin-livepeer-bridge/`. If Biome: `biome.json` + per-rule `.grit` files under `lint/biome/`.

3. **Port all six rules** with exhaustive test cases — every rule has both positive ("this violates") and negative ("this is fine") fixtures.

4. **Integrate into `npm run lint`.** Replace the layer-check stub (`lint/layer-check/index.mjs`) with a thin shim that runs the plugin OR remove it entirely if the plugin covers everything.

5. **Backfill against the current tree.** Run the plugin in report-only mode first; fix any violations (there shouldn't be many if any — the conventions have been enforced by review); then flip to error.

6. **CI enforcement.** `npm run lint` already runs in `.github/workflows/lint.yml`. No new CI needed once the rules live inside it.

7. **Documentation.** Update `lint/README.md` to reflect what's shipped vs still planned. If we migrate to Biome, update `eslint.config.js` status in `AGENTS.md` too.

## Decision point: Biome vs ESLint

This plan's day-1 spike decides. The question is specifically: **can Biome's plugin system express all six rules with less friction than ESLint, and if not, is partial Biome adoption (formatter only) worth the split-tool complexity?**

### Three candidate outcomes from the spike

| Option                                       | Biome                                     | ESLint                                                                   | When to pick                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Full ESLint**                           | —                                         | Keeps current ESLint config + ships the 6 custom rules as a local plugin | Default if the spike shows Biome GritQL can't express ≥ 1 rule cleanly                                                                         |
| **B. Biome formatter + ESLint custom rules** | Replaces Prettier                         | Keeps custom rules                                                       | If Biome's formatter is a clear win but GritQL doesn't cover custom rules well                                                                 |
| **C. Full Biome**                            | Formatter + all 6 custom rules via GritQL | Retire `typescript-eslint`                                               | Only if the spike shows GritQL expresses all 6 cleanly AND Biome's default ruleset covers equivalent ground to `typescript-eslint` recommended |

### What makes each rule risky on Biome

| Rule                      | Risk on Biome GritQL | Reason                                                                                                                                                                                                                                                |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer-check`             | **Medium**           | GritQL matches AST patterns; expressing "file at layer N may not import from layers ≥ N" requires cross-referencing the file's path with the imported module's resolved path. Feasible, not idiomatic.                                                |
| `no-cross-cutting-import` | **Low**              | Plain path-scoped import-denylist. GritQL handles this idiomatically.                                                                                                                                                                                 |
| `zod-at-boundary`         | **Medium**           | "First statement of a function body must be X" is a structural assertion. GritQL can match it but the pattern is awkward.                                                                                                                             |
| `no-secrets-in-logs`      | **Low**              | Pattern-match call-expression arguments against a denylist. Idiomatic GritQL.                                                                                                                                                                         |
| `file-size`               | **Low**              | Not an AST rule at all; Biome already has a built-in.                                                                                                                                                                                                 |
| `src/types/` shape        | **High**             | Requires a per-file existence assertion ("this file exports both X and Y"). GritQL is match-based, not whole-file analytical. May need to express as two separate rules (must-export-Schema + must-export-inferred-type) both keyed on filename glob. |

### Wins Biome would bring if adopted fully

- Single tool: replaces both ESLint and Prettier with one binary and one config.
- 10–100× faster on this codebase's scale (small gain; not a current pain point).
- No `eslint-config-prettier` dance.

### Costs Biome would bring

- Losing `typescript-eslint` recommended. Would need an audit of which rules from it are actually catching real issues in this codebase — if any are load-bearing, re-implement or accept the regression.
- `typescript-eslint` rule-author ecosystem is huge; Biome's is small. If we want a seventh rule later, ESLint is probably still the shorter path.
- Biome's plugin system maturity — GritQL is newer; edge cases around TypeScript-specific ASTs (generics, satisfies, etc.) may be undercooked.

### Recommended default (if spike is inconclusive)

**Option A (full ESLint).** The custom-rule story is what we're actually buying; `typescript-eslint` is the mature one. Speed isn't our bottleneck.

## Decisions log

### 2026-04-24 — Spike result: Option A (full ESLint) wins

Reason: Ran a throwaway spike against `@biomejs/biome` v2.4.13 covering three representative rules on scratch TS fixtures:

- **`no-cross-cutting-import`** (rule #2): Biome GritQL handled this cleanly. The `plugins` key in `biome.json` plus `overrides.includes` scoped to the non-provider source dirs gave exactly the "forbid `import pg` outside `providers/`" behavior we need. Error messages were decent. This one Biome wins.
- **`layer-check` / path-scoped** (rule #1): Path scoping via `overrides.includes` works; the rule itself would compose from several small GritQL files (one per forbidden pairing) rather than a single "check the full layer matrix" plugin. Workable but more files than the equivalent ESLint rule.
- **`zod-at-boundary`** (rule #3): Multiple GritQL patterns (`$name <: r"..."`, `$body <: not contains`) either failed to narrow matches or produced opaque match counts. The documentation for GritQL-over-TypeScript is sparse; debugging "why didn't my pattern fire?" was slow. Expressible in principle but rough in practice for structural assertions.
- **`src/types/` shape lint** (not spiked, inferred): requires expressing "this file must export both X and Y" as two separate negate-match patterns firing when an export is missing. Feasible but forced — GritQL's pattern-match paradigm doesn't love per-file existence invariants.

Additional factors tipping toward ESLint:

- Losing `typescript-eslint` recommended would be a real regression (`no-unused-vars`, `no-misused-promises`, `no-floating-promises`, etc. catch real bugs we'd otherwise ship).
- `@typescript-eslint/utils` + `RuleTester` is documented to death; local plugin authoring is a well-trodden path.
- Our rate of rule authoring in this project is low — we're buying one plugin with six rules, not an ongoing investment. The cost of learning GritQL idioms doesn't amortize.

**Not chosen:** Option B (Biome formatter + ESLint rules). The formatter win is real but `docs/design-docs/*.md` and every repo file already passes through Prettier. Switching formatters means one mass-reformat commit on every file — churn that doesn't buy anything the 1s current `npm run fmt` cost isn't paying.

Revisit this in 18 months when Biome's plugin ecosystem matures.

### 2026-04-24 — Plugin lives at `lint/eslint-plugin-livepeer-bridge/` (local workspace, not published)

Reason: No sibling repo consumes these rules yet. Local plugin referenced from `eslint.config.js` avoids npm-publish ceremony for v1. If the payment library or a future repo wants the rules, promote to a published package under a `@livepeer-cloud-spe/eslint-plugin` namespace.

### 2026-04-24 — Rules registered individually; no "recommended" preset

Reason: Six rules, all intended to be on together. A `recommended` preset would just enumerate them. Skipping the preset keeps the plugin surface small.

## Open questions

- Does Biome GritQL actually handle `zod-at-boundary`'s "first statement" pattern idiomatically? — answered by the spike.
- Do we care about preserving typescript-eslint recommended rules (which catch e.g., `no-unused-vars`, `no-misused-promises`, `prefer-as-const`)? — audit against actual violations in this codebase.
- Plugin distribution: local workspace plugin vs. versioned npm package. Local-workspace is fine for v1; publishing comes if a sibling repo wants the rules.

## Artifacts produced

- Local ESLint plugin: `lint/eslint-plugin-livepeer-bridge/` — `package.json`, `index.js`, and one rule file per lint under `rules/`.
- `eslint.config.js` — registers the plugin and turns all six rules on (`error` for five, `warn` for `file-size`); adds `src/providers/payerDaemon/gen/**` to the global ignore.
- Retired stub: removed `lint/layer-check/index.mjs` and its script entry in `package.json#lint` — `npm run lint` now runs `eslint .` only.
- `lint/README.md` — rewritten to document the shipped rules, exemption patterns, plugin skeleton, and error-message format.
- Spike notes captured in the decisions log above (Biome vs ESLint).
- Code fixes during backfill:
  - `src/main.ts` — dropped a now-unused `/* eslint-disable no-console */` directive.
  - `src/runtime/http/chat/streaming.ts` — removed unused `RawSseEvent` import; added `// eslint-disable-next-line livepeer-bridge/zod-at-boundary` with justification on `handleStreamingChatCompletion` (body is already Zod-parsed by the caller).
  - `src/runtime/http/stripe/webhook.ts` — same disable on `handleWebhook` (validates via `stripe.webhooks.constructEvent`, same invariant, different mechanism).
  - `src/service/payments/payments.test.ts` — two `let` → `const` (never reassigned).
- Tests: 223 still passing, coverage unchanged at 91.36% stmt / 80.33% branch.
- Tech-debt closed: `layer-check ESLint plugin — stub only` and `src/types/ shape lint not enforced` both struck through in `tech-debt-tracker.md` with a pointer to 0014.
