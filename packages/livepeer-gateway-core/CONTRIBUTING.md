# Contributing

Thanks for your interest in `@cloudspe/livepeer-gateway-core`. This
project is small, agent-first, and pre-1.0 — contributions are welcome
but the bar for changes that touch the public adapter contracts is
higher than for internal cleanup.

## How to file a bug

Open a GitHub issue using the [Bug report](.github/ISSUE_TEMPLATE/bug.yml)
template. The template asks for:

- The `@cloudspe/livepeer-gateway-core` version (`npm ls @cloudspe/livepeer-gateway-core`).
- The Node version (`node --version`).
- A minimal reproduction — smallest code that triggers the bug. A
  failing test against `@cloudspe/livepeer-gateway-core/service/billing/inMemoryWallet.js`
  is best.
- Expected vs. actual behavior.

Bugs without a minimal repro get the `needs-repro` label and may be
closed if no repro arrives within 30 days.

## How to propose a feature

Open a GitHub issue using the [Feature proposal](.github/ISSUE_TEMPLATE/proposal.yml)
template. Maintainers respond within 7 days with one of:

- *Yes, send a PR* (small / scoped changes).
- *Yes, but write an exec-plan first* (non-trivial features touching
  the adapter contracts, the engine schema, or the dispatcher
  pipeline). Drop a markdown plan into `docs/exec-plans/active/` —
  see existing plans for the shape.
- *No, here's why* (out of scope / better solved elsewhere).

Don't start a non-trivial PR without a maintainer ack first — the
review cost is too high to merge speculative work.

## Dev setup

```sh
git clone https://github.com/Cloud-SPE/livepeer-gateway-core.git
cd livepeer-gateway-core
npm install
npm test
npm run lint
```

Required tools:

- Node 20 or newer.
- Docker (for the integration tests — TestPg starts a real Postgres
  container; mocking the DB is explicitly disallowed for the engine
  repo + billing layers).

If Docker isn't available, set `TEST_PG_HOST=localhost` (etc.) to point
at an existing Postgres instance. See `src/service/billing/testPg.ts`
for the full env-override list.

## Testing rules

- Every PR maintains the **75% coverage floor** on all v8 metrics
  (lines / branches / functions / statements). The vitest config
  enforces this on every run; PRs that drop coverage below the floor
  fail CI.
- Integration tests use real dependencies — a real Postgres via
  TestPg, a real Fastify server bound to an ephemeral port, real fake
  worker nodes via `Fastify` instances. **Don't mock the database.**
  Mocked tests have masked real bugs in this codebase before; the
  rule exists to keep the repro fidelity high.
- New code requires new tests. Coverage-by-coincidence (one e2e
  exercising a path that has no unit test) doesn't count.
- See `docs/adapters.md` for the contract tests new Wallet /
  AuthResolver / RateLimiter / Logger / AdminAuthResolver impls
  should pass before they ship.

## Code style

- Prettier handles formatting: `npm run fmt` to auto-format,
  `npm run fmt:check` to verify.
- ESLint enforces:
  - The `livepeer-bridge/layer-check` rule (types → config → repo →
    service → runtime; providers cross-cutting). Don't disable it
    locally — restructure the code instead.
  - `livepeer-bridge/zod-at-boundary` — Zod schemas only at the
    HTTP/gRPC boundary or at parse time; downstream layers consume
    typed values, not raw shapes.
  - File-size soft cap of 400 lines. Larger files get a lint warning;
    refactor before adding more.
- TypeScript is strict (`strict: true`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).

## Commit + PR conventions

- [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. The PR
  title becomes the squash-merge commit subject.
- DCO sign-off required: every commit needs `Signed-off-by: Your Name
  <email>` (use `git commit -s`). This avoids a heavyweight CLA while
  asserting authorship rights consistent with MIT.
- One concept per PR. Drive-by refactors go in a separate PR.
- CHANGELOG.md update under `## [Unreleased]` for any change touching
  public surface (adapters, exports, schema, default impls).

## Pre-1.0 policy

Pre-1.0 (`0.x`) versions allow breaking changes — minor version bumps
signal them, but they're permitted without a major bump. The
CHANGELOG must call out every breaking change.

1.0 ships when the first external production adopter signs off on the
adapter contracts.

Post-1.0 follows strict [Semantic Versioning](https://semver.org/):
breaking changes require a major bump and a migration guide.

## Adapter contracts

The five operator-overridable adapters are a stable contract. Changes
to their TypeScript signatures are breaking and require:

- A CHANGELOG entry under `### Changed` (pre-1.0) or a major version
  bump (post-1.0).
- An exec-plan in `docs/exec-plans/active/` with the rationale.
- Migration notes for downstream consumers.

The adapters live in `src/interfaces/`:

- `Wallet` — billing/quota authority. Reserve/commit/refund pattern.
- `AuthResolver` — turns an HTTP `Authorization` header into a
  generic `Caller`.
- `RateLimiter` — per-caller request gating.
- `Logger` — structured log sink.
- `AdminAuthResolver` — admin-token / basic-auth backing for the
  optional operator dashboard.

`ServiceRegistryClient` is **not** on the operator-overridable list —
the engine commits to the
[`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon)
as the canonical discovery source. See `docs/adapters.md` for the
deeper rationale.

## Code of Conduct

By contributing you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
Report concerns to <conduct@livepeer.cloud>.
