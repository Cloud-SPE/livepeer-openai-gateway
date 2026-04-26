---
id: 0028
slug: oss-readiness
title: OSS readiness — LICENSE/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/CHANGELOG/GOVERNANCE/issue+PR templates for the public Cloud-SPE/livepeer-bridge-core repo; runs in parallel with stages 1–4
status: active
owner: agent
opened: 2026-04-26
---

## Goal

Author the community-hygiene artifacts the public engine repo (`Cloud-SPE/livepeer-bridge-core`) needs before its first external adopter shows up. Runs in parallel with the four extraction stages ([`0024`](./0024-engine-extraction-interfaces.md) through [`0027`](./0027-engine-extraction-public-release.md)) — the docs are drafted here and committed to the public repo when stage 4 bootstraps it.

Non-blocking for stages 1–3 (which produce no public artifacts). Hard-blocks stage 4's `npm publish` until LICENSE + README are written; the rest can land within the first week post-publish.

## Non-goals

- No marketing site, blog post, or announcement copy. Those are growth-phase, not OSS-readiness.
- No GitHub Discussions or Wiki. Issue + PR templates only.
- No CLA (Contributor License Agreement). Default to DCO (Developer Certificate of Origin) via the standard `Signed-off-by` line in commits — lighter weight, sufficient for MIT.
- No multi-language support. English only at v1.
- No third-party governance services (CodeTriage, AllContributors, etc.). Plain markdown + GitHub-native features.
- No fork of [contributor-covenant.org](https://www.contributor-covenant.org)'s text — we adopt v2.1 verbatim per convention.
- No new behavior or API changes — pure documentation + repo hygiene.

## Approach

### 1. LICENSE

Plain `LICENSE` file at the public repo root, MIT verbatim:

```
MIT License

Copyright (c) 2026 Cloud-SPE contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
...
```

(Standard MIT text. "Cloud-SPE contributors" not "Cloud-SPE Inc." — recognizes the open contribution model from day one.)

`package.json`: `"license": "MIT"` (was `"TBD"`).

### 2. CONTRIBUTING.md

Sections:

- **How to file a bug** — link to `.github/ISSUE_TEMPLATE/bug.yml`. Include version + Node version + minimal repro.
- **How to propose a feature** — open a discussion-style issue first (use `proposal.yml` template); maintainers respond within 7 days; non-trivial features need an exec-plan in `docs/exec-plans/active/` before code.
- **Dev setup** — `git clone`, `npm install`, `npm test`, `npm run lint`. Required tools: Node 20+, Postgres for integration tests (optional, `npm run test:nodb` skips).
- **Testing rules** — every PR maintains the 75% coverage floor on all v8 metrics; new tests required for new code; integration tests use TestPg, not mocks (per the project's existing coverage-threshold and integration-tests-must-hit-real-db conventions).
- **Code style** — Prettier handled by `npm run fmt`; ESLint enforces the layer rule, no exceptions.
- **Commit + PR conventions** — Conventional Commits (`feat:`, `fix:`, `docs:`, etc.); PR title becomes the squash-merge commit subject; DCO sign-off required (`git commit -s`).
- **Pre-1.0 policy** — breaking changes are OK at 0.x; document them in CHANGELOG. 1.0 is cut on first external adopter.
- **Adapter contracts** — link to `docs/adapters.md`. Changes to `Wallet`/`AuthResolver`/`RateLimiter`/`Logger`/`AdminAuthResolver` shape are breaking; require explicit changelog entry + version bump (minor pre-1.0, major post-1.0).
- **Code of Conduct** — link to `CODE_OF_CONDUCT.md`. By contributing, you agree to abide by it.

### 3. SECURITY.md

```
# Security policy

## Supported versions
We backport security fixes to the latest minor release in the current pre-1.0 series.
Once 1.0 ships, we maintain the latest two minor versions.

## Reporting a vulnerability
Email <security@cloud-spe.example> (replace with real address before publish).
Do NOT open a public GitHub issue.
We acknowledge within 48 hours and aim to ship a patched release within 14 days.

## Disclosure
Coordinated disclosure. Reporters credited in CHANGELOG.md if they wish.

## Scope
- Auth/authorization bugs in adapter interfaces or default impls
- Payment-daemon integration vulnerabilities
- Pricing/billing math errors that could be exploited
- Dependency advisories affecting the engine

Out of scope: the operator's own Wallet/AuthResolver impl (operator-owned).
```

The `security@cloud-spe.example` address is a placeholder — must be replaced with a real monitored inbox before publish.

### 4. CODE_OF_CONDUCT.md

Adopt [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct.html) verbatim. Replace the contact email placeholder with `<conduct@cloud-spe.example>` (real inbox required before publish).

### 5. CHANGELOG.md

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format:

```
# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
post-1.0.

## [Unreleased]

## [0.1.0] - 2026-04-XX
### Added
- Initial extraction from openai-livepeer-bridge.
- Wallet, AuthResolver, RateLimiter, Logger, AdminAuthResolver adapter interfaces.
- Framework-free dispatchers for chat completions (streaming + non-streaming),
  embeddings, image generations, audio speech, audio transcriptions.
- Fastify adapter at `@cloud-spe/bridge-core/fastify`.
- Optional read-only operator dashboard at `@cloud-spe/bridge-core/dashboard`.
- InMemoryWallet reference implementation for testing.
- examples/minimal-shell runnable example.
```

### 6. GOVERNANCE.md

```
# Governance

## Maintainers
- Mike Zupper (@mazup) — initial author, project lead

## Decision-making
- Day-to-day: maintainer rough consensus.
- Architectural changes (adapter interface shape, engine schema, semver-affecting changes):
  exec-plan in docs/exec-plans/active/, two-business-day comment window before merge.
- Breaking changes (pre-1.0): documented in CHANGELOG; minor version bump.
- Breaking changes (post-1.0): exec-plan required; major version bump.

## Adding maintainers
Invite-only, by existing-maintainer consensus, after sustained quality contributions.
Non-binding goal: at least two active maintainers.

## Forking
MIT permits forks. We ask (don't require) that forks rename to avoid confusion
with upstream releases.
```

### 7. Issue + PR templates

`.github/ISSUE_TEMPLATE/bug.yml`:

```yaml
name: Bug report
description: Something is broken or behaves unexpectedly
labels: [bug, triage]
body:
  - type: input
    id: version
    attributes: { label: Version, description: "@cloud-spe/bridge-core version" }
    validations: { required: true }
  - type: input
    id: node
    attributes: { label: Node version, description: "node --version output" }
    validations: { required: true }
  - type: textarea
    id: repro
    attributes: { label: Minimal reproduction, description: "Smallest code that triggers the bug" }
    validations: { required: true }
  - type: textarea
    id: expected
    attributes: { label: Expected behavior }
  - type: textarea
    id: actual
    attributes: { label: Actual behavior }
  - type: textarea
    id: logs
    attributes: { label: Logs / stack trace, render: shell }
```

`.github/ISSUE_TEMPLATE/proposal.yml`:

```yaml
name: Feature proposal
description: Propose a new feature or behavior change
labels: [proposal, triage]
body:
  - type: textarea
    id: motivation
    attributes: { label: Motivation, description: "What problem does this solve? Who's affected?" }
    validations: { required: true }
  - type: textarea
    id: shape
    attributes: { label: Proposed shape, description: "API/interface sketch (TypeScript signatures preferred)" }
  - type: textarea
    id: alternatives
    attributes: { label: Alternatives considered }
  - type: checkboxes
    id: scope
    attributes:
      label: Scope
      options:
        - label: This is a breaking change to a public adapter interface
        - label: This requires a schema migration
        - label: This adds a new public export path
```

`.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## Summary
<1–3 sentences>

## Linked exec-plan
<docs/exec-plans/active/00XX-*.md, or "ephemeral" for trivial changes>

## Test plan
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Coverage stays ≥ 75% on all v8 metrics
- [ ] CHANGELOG entry added (under Unreleased)

## Breaking changes
<None, or describe + flag the version bump required>

## Sign-off
By submitting, I agree to the [DCO](https://developercertificate.org/) — my commit messages include `Signed-off-by:`.
```

### 8. README.md

Authored as part of stage 4 (referenced from there). This plan only ensures the LICENSE + first-line-of-README sentence ("Open-source under MIT") are correct.

### 9. Sample adapter docs

`docs/adapters.md` in the public repo. Long-form guide:

- Why adapters? (one-paragraph framing)
- `Wallet` interface — full TS signature, semantics of `null` reservation, partial-commit semantics, refund-on-failure.
- `AuthResolver` — full TS signature, tier-string convention, examples (bearer-token, mTLS, API key in header).
- `RateLimiter` — interface + Redis sliding-window default impl docs.
- `Logger` — interface + console default + pino integration example.
- `AdminAuthResolver` — interface + basic-auth default + token-based example.
- Pattern: building a postpaid B2B Wallet (returns `null` from `reserve`, records actuals on `commit`).
- Pattern: building a crypto Wallet (reads `wei` from `CostQuote`).
- Pattern: building a free-quota Wallet (reads `actualTokens` from `UsageReport`).
- Reference: `examples/minimal-shell/` and `examples/wallets/{postpaid,prepaid-usd,free-quota}/`.

### 10. `examples/wallets/`

Three illustrative Wallet stubs in the public repo (committed but flagged "illustrative — not production-ready"):

- `examples/wallets/postpaid.ts` — `reserve` returns null; `commit` writes a record; `refund` is a no-op.
- `examples/wallets/prepaid-usd.ts` — `reserve` decrements an in-memory balance by `quote.cents`; `commit` adjusts to `usage.cents`; `refund` re-credits.
- `examples/wallets/free-quota.ts` — `reserve` decrements token allowance by `quote.estimatedTokens`; `commit` adjusts to `usage.actualTokens`.

Each is a single-file, ~50-LOC stub with an `npm test` smoke test.

## Steps

- [ ] Author `LICENSE` (MIT verbatim, "Cloud-SPE contributors" copyright)
- [ ] Author `CONTRIBUTING.md` (sections: bug, proposal, dev setup, testing, style, commits, pre-1.0 policy, adapter contracts, CoC)
- [ ] Author `SECURITY.md` (with placeholder email; flag must-replace before publish)
- [ ] Author `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1 verbatim)
- [ ] Author `CHANGELOG.md` (Keep a Changelog format; 0.1.0 entry stub)
- [ ] Author `GOVERNANCE.md` (maintainers, decision rules, adding maintainers)
- [ ] Author `.github/ISSUE_TEMPLATE/bug.yml` + `proposal.yml`
- [ ] Author `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] Author `docs/adapters.md` (public-repo destination)
- [ ] Author `examples/wallets/{postpaid,prepaid-usd,free-quota}.ts` + `examples/wallets/README.md`
- [ ] Provision real `security@` and `conduct@` inboxes; replace placeholders
- [ ] Confirm `package.json` field `"license": "MIT"` (was "TBD")
- [ ] Confirm all the above are committed to `Cloud-SPE/livepeer-bridge-core` BEFORE the `v0.1.0` tag in [`0027`](./0027-engine-extraction-public-release.md) is pushed

## Decisions log

(empty)

## Open questions

1. Real inbox addresses for `security@` and `conduct@` — placeholders must be swapped before publish. Who provisions?
2. `GOVERNANCE.md` lists Mike Zupper (@mazup) as initial maintainer. Add others now or wait for sustained contributions? Default: solo until contribution patterns suggest co-maintainers.
3. CLA vs DCO: defaulting to DCO (lighter, sufficient for MIT). Re-evaluate if any contributor's employer asks for CLA.

## Artifacts produced

(empty until in-flight)
