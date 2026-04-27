# AGENTS.md — `@cloudspe/livepeer-gateway-core`

This is the engine half of an OpenAI-compatible gateway over Livepeer
worker pools. It is **agent-first**: the contributor process leans on
exec-plans, well-tested adapter contracts, and a hard 75% coverage
floor instead of human-only review.

**Humans steer. Agents execute. Scaffolding is the artifact.**

## What this engine is

- A **request engine** that takes an OpenAI-compatible HTTP request,
  authenticates it, gates it on rate-limit + Wallet, picks a worker
  node from a registry-daemon-backed pool, calls the worker, commits
  payment via the payment-daemon, and writes a usage record.
- **Framework-free**: dispatchers under `src/dispatch/*` accept all
  their dependencies as constructor args; nothing reaches into a
  global. The Fastify adapter under `src/runtime/http/*` is one
  consumer; alternative adapters (Hono, plain Node http) can be
  written as siblings without touching the dispatchers.
- **Adapter-driven**: five operator-supplied interfaces (`Wallet`,
  `AuthResolver`, `RateLimiter`, `Logger`, `AdminAuthResolver`) cover
  every concern that varies by deployment. Inside the engine they
  are stable contracts.

## What this engine is NOT

- **Not a billing system** — `Wallet` is operator-supplied. The
  engine doesn't know about USD vs. wei vs. tokens; it asks for a
  reservation, dispatches, and reports actuals.
- **Not an identity provider** — `AuthResolver` is operator-supplied.
  The engine accepts opaque `Caller.id` / `tier` / `rateLimitTier`
  strings and threads them through.
- **Not a multi-protocol gateway** — strictly OpenAI-compatible. If
  you need `/v1/responses` or a non-OpenAI shape, fork or compose.
- **Not a discovery system** — node identity comes from the
  service-registry-daemon (a sister repo). The engine pins the
  daemon's gRPC contract and does not support a static-YAML
  fallback.

## Layer stack (lint-enforced)

Imports flow strictly downward; the `livepeer-bridge/layer-check`
rule fails CI on a violation. `providers/` is cross-cutting and
reachable from every layer.

```
types ── config ── repo ── service ── runtime
                                        │
                                  providers (cross-cutting)
```

- **types/** — Zod schemas + branded TS types. No runtime imports
  beyond `zod`.
- **config/** — env-var loaders, each Zod-validated. Throw on
  invalid; let `main()` decide the failure mode.
- **repo/** — thin Drizzle-backed query helpers. Schema is namespaced
  under `engine` (`engine.usage_records`, `engine.node_health`,
  `engine.node_health_events`). `caller_id` is opaque text — the
  engine never resolves the FK to any shell schema.
- **service/** — business logic. Domains: `payments`, `routing`,
  `pricing`, `tokenAudit`, `rateLimit`, `metrics`, `admin/engine`,
  `billing/inMemoryWallet`. Cross-domain composition happens in the
  layer above (runtime + dispatch).
- **runtime/** — Fastify route registers + middleware + Prometheus
  scrape server. Composes service-layer pieces into the HTTP
  surface.
- **dispatch/** — protocol-correct dispatchers (chat completion
  streaming + non-streaming, embeddings, image generations, audio
  speech, audio transcriptions). Pure functions over interfaces.
- **providers/** — adapter impls for the dependencies the engine
  doesn't own (Postgres, Redis, Fastify, prom-client, gRPC clients,
  the Tiktoken provider, the NodeClient HTTP fetcher). All
  cross-cutting; any layer may import.

## Core beliefs (non-negotiable)

These are baked into CI gates. Don't propose changing them without
an exec-plan.

- **75% coverage floor** on all v8 metrics. The vitest config
  enforces this; PRs that drop below fail CI.
- **Integration tests use real Postgres**, not mocks. TestPg starts
  a Testcontainers-managed Postgres for every run. Mocked DB tests
  have masked real bugs in this codebase.
- **Layer rule + cross-cutting providers** as described above. No
  exceptions.
- **Zod at boundaries only.** HTTP and gRPC ingress + outbound
  worker calls validate via Zod; downstream code consumes typed
  values. No `safeParse` deep in the call stack.
- **No secrets in logs.** `livepeer-bridge/no-secrets-in-logs` ESLint
  rule scans for `apiKey`, `password`, `secret`, `pepper` etc. in
  logger argument shapes. Trips fast on accidental log calls.
- **Adapter contracts are stable.** Changes to the five
  operator-overridable adapter interfaces require an exec-plan and
  a CHANGELOG entry under `### Changed`. Pre-1.0 → minor bump;
  post-1.0 → major bump + migration guide.

## Working on this engine

### Non-trivial changes start with an exec-plan

Drop a markdown file into `docs/exec-plans/active/00XX-slug.md`
before writing code. The plan should cover:

- **Goal** — what's the after-state?
- **Non-goals** — what's deliberately not in scope?
- **Approach** — section-by-section how the change lands.
- **Steps** — checkbox list, granular enough that each is one
  commit-sized piece of work.
- **Decisions log** — fill in as you learn things during
  implementation.

When the plan ships, move it to `docs/exec-plans/completed/`.
Existing completed plans are decent templates for shape.

### "Trivial" changes (skip the plan)

- Bug fixes with a failing test that reproduces the bug.
- Doc fixes / typos.
- Dependency bumps that don't change public surface.
- Test additions that don't change source.

### Test before writing code

Failing test first; passes after the implementation lands. The
75% coverage floor is enforced per-PR — a PR that adds untested
lines fails CI.

### Run local checks before pushing

```sh
npm run typecheck
npm run lint
npm test
```

CI runs all three in a Node 20 + 22 matrix. Pushing without
running locally invites a slow round-trip.

### Adapter contract changes

The five interfaces in `src/interfaces/` are the public stable
contract. Changing them is high-cost:

1. Open an exec-plan first.
2. Two-business-day comment window before merge (per `GOVERNANCE.md`).
3. CHANGELOG entry under `### Changed` flagging the breaking change.
4. Update `examples/wallets/*` and `examples/minimal-shell/` to
   demonstrate the new shape.
5. If post-1.0, major version bump + migration guide in
   `CHANGELOG.md`.

Same ladder applies to:
- The Drizzle schema (`src/repo/schema.ts`).
- The metric prefix or build-info gauge shape
  (`src/providers/metrics/recorder.ts`).
- Public exports under `@cloudspe/livepeer-gateway-core/*`.
- The `ServiceRegistryClient` engine-internal contract.

## See also

- [`README.md`](README.md) — public-facing entry point.
- [`DESIGN.md`](DESIGN.md) — what the engine is + isn't, in
  longer form.
- [`docs/architecture.md`](docs/architecture.md) — internals:
  layer stack, dispatcher pipeline, payment-daemon integration.
- [`docs/adapters.md`](docs/adapters.md) — long-form adapter guide.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, commit + PR
  conventions, adapter-contract change ladder.
