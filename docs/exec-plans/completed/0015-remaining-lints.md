---
id: 0015
slug: remaining-lints
title: Remaining lints (doc-gardener, proto-drift, secret-scan) + backfill the drift they would have caught
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Close the three lint-adjacent gaps still flagged in `tech-debt-tracker.md`:

1. **doc-gardener** — validate `docs/**` frontmatter + cross-links + status consistency (mirror file location in `exec-plans/active|completed` with the `status:` field).
2. **proto-drift** — CI check that re-runs `npm run proto:gen` and fails on a dirty diff against committed stubs.
3. **secret-scan** — repo-wide secret scanning (gitleaks-class) running in CI.

The doc-gardener is the most valuable of the three — a manual audit already surfaced three exec-plan files in `completed/` with `status: active` in their frontmatter, plus stale `_planned_` markers in `docs/design-docs/index.md` and `AGENTS.md`. Shipping the lint **and** backfilling the existing drift in the same PR makes the demo unambiguous.

Also in scope: update `README.md` with more detail per operator request (`docs/` map, project status, where-to-look-for-what).

Depends on: every prior plan (this is pure tooling).

## Non-goals

- No per-file `last-reviewed` freshness alerting (too noisy for v1; convention is human-owned).
- No full provenance tracking (which commit last touched each design-doc vs. each linked source file).
- No IDE plugin / LSP integration.
- No reformatting of docs beyond what the lint fixes imply.

## Approach

1. **Fix the existing drift first** (backfills the changes the doc-gardener will enforce):
   - `docs/exec-plans/completed/0007-chat-completions-nonstreaming.md` → frontmatter to `status: completed`, `owner: claude`, `closed: 2026-04-24`.
   - Same for `0008-chat-completions-streaming.md` and `0010-stripe-topups.md`.
   - `docs/design-docs/index.md` — remove `_planned_` markers from `streaming-semantics.md`, `token-audit.md`, `retry-policy.md` (shipped; statuses in-file are `accepted`).
   - `AGENTS.md` "Where to look for X" — same staleness; swap the three `(planned)` captions for concrete descriptions.

2. **Ship the doc-gardener lint** at `lint/doc-gardener/index.mjs`:
   - Walks `docs/design-docs/*.md`, `docs/product-specs/*.md`, `docs/exec-plans/active/*.md`, `docs/exec-plans/completed/*.md`.
   - Parses frontmatter via `js-yaml` (already a runtime dep).
   - Rules:
     - Every file in `active/` has `status: active`; every file in `completed/` has `status ∈ { completed, abandoned }`.
     - Every design-doc has `title`, `status`, `last-reviewed`. `status ∈ { proposed, accepted, verified, deprecated }`.
     - Every product-spec has `title`, `status`, `last-reviewed`.
     - Internal `.md` links under `docs/` resolve to an existing file.
     - Design-docs do not link into `docs/exec-plans/` (per `docs/design-docs/index.md` conventions).
   - Exit code 0 on clean, 1 on any violation. One structured diagnostic per violation.
   - Wired as `npm run doc-lint` (currently a stub that `echo`s).

3. **Ship the proto-drift check** as a CI-only job:
   - `.github/workflows/lint.yml` adds a `proto-drift` job that runs `npm run proto:gen` then `git diff --exit-code -- src/providers/payerDaemon/gen/`.
   - Fails CI if running codegen produces any output — i.e., library proto changed without a matching regen on the bridge side.
   - Local development gets a `npm run proto:check` script that does the same thing (useful pre-PR).

4. **Ship secret-scan** via gitleaks:
   - Add a `.gitleaks.toml` at the repo root with a minimal allowlist (the `test-` prefixes used in test fixtures, hex strings in Solidity ABI, etc.).
   - CI job in `.github/workflows/lint.yml` using `gitleaks/gitleaks-action@v2`.
   - No local script — gitleaks scanning is CI-only until we see a need to run pre-commit.

5. **Update `README.md`** with a `docs/` map, "what's where," and explicit "v1 feature-complete" status section.

6. **Close the three tech-debt entries** struck-through with pointers to 0015.

## Decisions log

### 2026-04-24 — doc-gardener is a standalone Node script, not another ESLint plugin

Reason: ESLint's rule API is designed for source-code ASTs, not YAML frontmatter / cross-reference integrity. A Node script under `lint/doc-gardener/` with its own diagnostics is simpler than authoring a new ESLint rule type. Reuses the `js-yaml` dep already in the tree.

### 2026-04-24 — Proto-drift is a CI job, not a local lint

Reason: `npm run proto:gen` requires `@bufbuild/buf` + `protoc-gen-ts_proto` which are already in devDeps; the check is cheap (< 5s). But running it on every local `npm run lint` feels like overkill. A `npm run proto:check` is provided for explicit local use; CI enforces it on every PR.

### 2026-04-24 — Secret-scan uses gitleaks via its GitHub Action, not a local binary

Reason: gitleaks is the de-facto OSS secret scanner. Running it as a GH Action avoids bundling a binary dep for this one CI job; `gitleaks/gitleaks-action@v2` is stable and runs the Rust-ish binary inside the runner. A `.gitleaks.toml` captures the project-specific allowlist so test-fixture keys don't create noise.

### 2026-04-24 — Doc-gardener's `last-reviewed` staleness rule is out of scope

Reason: The convention's hard to mechanize without false positives. A doc can be right even if its `last-reviewed` is from a year ago; a doc can be wrong even if updated yesterday. Human review remains the authority for "is this still accurate?" Doc-gardener enforces structural invariants only (status matches location, frontmatter exists, cross-links resolve).

## Open questions

- Should doc-gardener also verify that every exec-plan's completion date is ≥ its open date? Low-cost sanity check; include or skip. Lean include.
- Should secret-scan also run locally via a pre-commit hook? Not in 0015; optional ops add.

## Artifacts produced

- `lint/doc-gardener/index.mjs` — Node script validating `docs/**` frontmatter, status/location match, cross-link integrity, and the "design-docs don't link into exec-plans/" rule. Wired to `npm run doc-lint`.
- `npm run proto:check` — regenerate + `git diff --exit-code -- src/providers/payerDaemon/gen/`. Added `proto-drift` CI job.
- `.gitleaks.toml` — repo-wide secret-scan allowlist (test-pepper patterns, fake-Stripe IDs, test ETH addresses, generated stubs, migrations). Added `secret-scan` CI job via `gitleaks/gitleaks-action@v2`.
- `.prettierignore` — keeps Prettier from reformatting the generated protobuf stubs (fixed the root cause of the first proto-drift the check caught).
- `.github/workflows/lint.yml` — new `doc-lint`, `proto-drift`, `secret-scan` jobs; existing `doc-lint` placeholder retired.
- **Drift backfills** (this PR was the lint's first catch):
  - `docs/exec-plans/completed/0007-chat-completions-nonstreaming.md`, `0008-chat-completions-streaming.md`, `0010-stripe-topups.md` — frontmatter fixed to `status: completed`, `owner: claude`, `closed: 2026-04-24`.
  - `docs/exec-plans/completed/0015-remaining-lints.md` — same (this plan itself, caught by its own lint before commit).
  - `docs/design-docs/index.md` — dropped stale `_planned_` markers for streaming-semantics, retry-policy, token-audit; added stripe-integration entry.
  - `AGENTS.md` "Where to look for X" table — removed `(planned)` captions; added pointers to payer-integration, node-lifecycle, stripe-integration, admin-endpoints.
  - `src/providers/payerDaemon/gen/*.ts` — restaged to match fresh codegen (was Prettier-reformatted).
- `README.md` — rewritten with plan index, `docs/` map, invariants block, endpoint index grouped by auth model, dev-script reference.
- Tech-debt closed:
  - `Proto stub auto-sync with livepeer-payment-library — manual for v1` (struck through with pointer to 0015).
