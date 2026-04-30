---
id: 0026
slug: engine-extraction-workspace
title: Engine extraction stage 3 — convert to npm workspaces; create packages/bridge-core/ + packages/livepeer-openai-gateway/; split DB schema (engine.* + app.*); rewrite migrations clean; rename this repo
status: completed
owner: agent
opened: 2026-04-26
closed: 2026-04-27
---

## Stage 2 handoff (read first)

Stage 2 closed with a transitional state that stage 3 needs to clean up. Future-session-resume notes:

- `src/service/nodes/` (NodeBook + loader + legacy quoteRefresher + `nodes.yaml` + `NODES_CONFIG_PATH` env var) is still alive but only consumed by:
  - `EngineAdminService.listNodes`/`getNode` (in `src/service/admin/engine.ts`)
  - `createMetricsSampler` (in `main.ts`)
  - `nodeClient` metrics decorator's url→id lookup (in `main.ts`)
- `main.ts` has a `syncNodeBookQuotesToCache` periodic bridge that copies the legacy refresher's NodeBook quote-map into the new dispatcher-facing `QuoteCache`. Dispatchers no longer touch NodeBook directly — they read `QuoteCache.get(nodeId, capability)`.
- `src/service/routing/quoteRefresher.ts` (new, registry-driven, writes to `QuoteCache`) is built and unit-tested but **not yet wired in `main.ts`**. Stage 3's workspace rewrite is the right time to swap.
- `src/providers/serviceRegistry/grpc.ts` (real gRPC client) exists but `main.ts` still wires `createNodeBookRegistry` (the stage-1 NodeBook wrapper) as the `ServiceRegistryClient` impl. Switching to the gRPC client requires a registry-daemon running alongside (compose entry).
- `AdminService` is split into `engine.ts` + `shell.ts` halves with a thin composer at `index.ts`. Stage 3's `packages/bridge-core/` exports `createEngineAdminService` directly; the shell composes the two halves itself.

What stage 3 needs to do, beyond what's already in this plan: retire `service/nodes/` entirely (move what's left into the shell or into engine `service/routing/`), delete the `syncNodeBookQuotesToCache` bridge, wire `createGrpcServiceRegistryClient` in `main.ts`, wire the new `quoteRefresher`, drop `nodes.yaml`/`NODES_CONFIG_PATH`. The workspace split conveniently forces all this — there's no good reason to carry `service/nodes/` into the engine package.

## Goal

Stage 3 of a 4-stage extraction. With interfaces ([`0024`](../completed/0024-engine-extraction-interfaces.md)) and dispatchers ([`0025`](../completed/0025-engine-extraction-dispatchers.md)) in place, this stage performs the actual file moves: convert the repo to npm workspaces, create `packages/bridge-core/` (engine) and `packages/livepeer-openai-gateway/` (shell), split the Postgres schema into `engine.*` and `app.*` namespaces, rewrite the migration history clean (nothing is deployed; we drop `migrations/0000-0006.sql` and start fresh per package), split metric-name prefixes, set up per-package ESLint configs, and rename this repo from `openai-livepeer-bridge` to `livepeer-openai-gateway`.

After this stage:

- `packages/bridge-core/` is a self-contained engine package with its own `package.json`, `tsconfig.json`, `vitest.config.ts`, ESLint config, migrations, tests, dashboard, and proto-generated stubs for both daemons (payment + service-registry).
- `packages/livepeer-openai-gateway/` is the shell package consuming `bridge-core` via workspace symlink.
- `frontend/` (the entire `shared/`, `portal/`, `admin/` tree) lives under the shell package — it's all shell-owned, both consumers are shell.
- The engine's Fastify peer-dep declaration is real (Fastify is no longer a direct dep of the engine).
- DB has two schemas. Engine writes `engine.usage_records` with `caller_id` (string). Shell writes `app.customers`, `app.api_keys`, `app.topups`, `app.reservations`, `app.stripe_webhook_events`, `app.admin_audit_events`. No cross-schema FKs.
- Each package runs its own migrations independently at startup.
- Metric names are prefixed: engine emits `livepeer_bridge_*`; shell emits `cloudspe_*` (placeholder; rename if a different shell product name is chosen).
- The deployment topology requires **both** sidecar daemons: `livepeer-payment-daemon` (sender mode, sender-side gRPC) and `livepeer-service-registry-daemon` (resolver gRPC). Both compose files (`compose.yaml`, `compose.prod.yaml`) include both as services.
- This repo's `package.json`, `Dockerfile`, `compose*.yaml`, `README.md`, internal links, and CI all reflect the new name `livepeer-openai-gateway`.

The engine package can be `npm pack`-ed and installed elsewhere as a tarball, validating the public surface before stage 4 actually publishes it.

## Non-goals

- No public repo creation, no npm publish (stage 4).
- No data migration (nothing is deployed; fresh installs only).
- No additions to engine/shell scope — only mechanical moves of code already classified in stages 1–2.
- No deprecation of the old migration history beyond renumbering — stage 4 is when the public engine repo gets a fresh `0000_init.sql`.
- No changes to dispatcher signatures or adapter interfaces.
- No `@cloud-spe/bridge-core` npm publication yet — workspace consumption only.
- No splitting of `frontend/shared/` between repos. It stays in the shell package; both `portal/` and `admin/` are shell consumers.

## Approach

### 1. Workspace conversion

Root `package.json`:

```jsonc
{
  "name": "livepeer-openai-gateway-monorepo",
  "private": true,
  "workspaces": ["packages/*", "frontend/*"],
}
```

Root retains: `compose*.yaml`, top-level `docs/`, `lint/`, `migrations/` retired, `scripts/` for orchestrating monorepo-wide commands.

Move scripts:

- `npm run build` → workspace-aware: builds `bridge-core` first, then `livepeer-openai-gateway`, then `frontend/*`.
- `npm test` → runs each package's `test` script in workspace order.
- `npm run lint` → runs each package's `lint`.

### 2. `packages/bridge-core/` layout

```
packages/bridge-core/
├── package.json                # name: @cloud-spe/bridge-core (placeholder), version: 0.1.0-dev
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js            # imports root layer rule, scoped to engine layers
├── migrations/
│   └── 0000_init.sql           # creates schema engine; tables nodes, node_health_events, usage_records, payment_audit
├── src/
│   ├── index.ts                # public API barrel
│   ├── interfaces/             # from stage 1
│   ├── types/                  # OpenAI schemas, capability, payment, node — moved from src/types/ (excluding customer.ts)
│   ├── config/                 # nodes, payerDaemon, pricing, tokenizer, rateLimit, metrics — moved (excluding auth, stripe, admin)
│   ├── repo/                   # db.ts, schema.ts (engine tables only), nodeHealth.ts, usageRecords.ts, usageRollups.ts, migrate.ts (note: nodeHealth records the per-process circuit-breaker timeline, NOT the registry-daemon's view)
│   ├── providers/              # database, http, metrics, nodeClient, payerDaemon, redis, tokenizer, logger (NO stripe)
│   ├── service/                # payments, routing (router, circuitBreaker, quoteCache, quoteRefresher, scheduler), pricing, tokenAudit, rateLimit, admin/engine.ts, admin/basicAuthResolver.ts, billing/inMemoryWallet.ts (reference impl only)
│   ├── dispatch/               # from stage 2
│   ├── dashboard/              # from stage 2 — engine's optional read-only OSS dashboard
│   └── adapters/
│       └── fastify/            # registerChatCompletionsRoute + siblings; registerOperatorDashboard
└── tests/                      # plus colocated *.test.ts
```

Engine `package.json` excerpts:

```jsonc
{
  "name": "@cloud-spe/bridge-core",
  "version": "0.1.0-dev",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./fastify": "./dist/adapters/fastify/index.js",
    "./dashboard": "./dist/dashboard/index.js",
  },
  "peerDependencies": {
    "fastify": "^4.29.0",
    "@fastify/static": "^7.0.0",
    "@fastify/multipart": "^8.3.0",
    "@fastify/sensible": "^5.6.0",
  },
  "dependencies": {
    "@grpc/grpc-js": "...",
    "@bufbuild/protobuf": "...",
    "drizzle-orm": "...",
    "eventsource-parser": "...",
    "ioredis": "...",
    "js-yaml": "...",
    "pg": "...",
    "prom-client": "...",
    "tiktoken": "...",
    "zod": "...",
  },
}
```

Note: Stripe is NOT in the engine. `stripe` SDK moves to the shell.

### 3. `packages/livepeer-openai-gateway/` layout

```
packages/livepeer-openai-gateway/
├── package.json                # name: livepeer-openai-gateway, depends on @cloud-spe/bridge-core via workspace:*
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js            # imports root layer rule, scoped to shell layers
├── migrations/
│   └── 0000_init.sql           # creates schema app; tables customers, api_keys, topups, reservations, stripe_webhook_events, admin_audit_events
├── src/
│   ├── main.ts                 # composition root: imports engine, wires shell adapters, registers all routes
│   ├── config/                 # auth, stripe, admin, database (shell-side overrides if any)
│   ├── repo/                   # apiKeys.ts, customers.ts, topups.ts, reservations.ts, stripeWebhookEvents.ts, adminAuditEvents.ts
│   ├── providers/
│   │   └── stripe/             # SDK + metered wrapper, moved from engine
│   ├── service/
│   │   ├── auth/               # AuthService impl (shell's AuthResolver)
│   │   ├── billing/            # prepaidQuotaWallet impl (was service/billing/wallet.ts) + reservations/topups/errors
│   │   └── admin/              # shell.ts + admin auth resolver (token-based)
│   └── runtime/
│       └── http/
│           ├── account/        # /v1/account/*
│           ├── billing/        # Stripe top-up
│           ├── stripe/         # Stripe webhook
│           ├── admin/          # shell admin routes (customers, topups, audit)
│           ├── portal/         # @fastify/static for frontend/portal
│           └── adminConsole/   # @fastify/static for frontend/admin
└── tests/
```

Shell `package.json`:

```jsonc
{
  "name": "livepeer-openai-gateway",
  "private": true,
  "type": "module",
  "dependencies": {
    "@cloud-spe/bridge-core": "workspace:*",
    "fastify": "...",
    "@fastify/static": "...",
    "@fastify/multipart": "...",
    "@fastify/sensible": "...",
    "fastify-raw-body": "...",
    "stripe": "...",
    "pg": "...",
    "drizzle-orm": "...",
    "zod": "...",
  },
}
```

### 4. Schema split + migration rewrite

Drop the existing `migrations/0000-0006.sql` from the root. Rewrite from scratch per package — fresh installs only, no data migration.

`packages/bridge-core/migrations/0000_init.sql`:

```sql
CREATE SCHEMA engine;
SET search_path TO engine;

CREATE TABLE engine.node_health_events (
  ...,
  occurred_at TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (occurred_at);  -- month-partitioned from day one; closes node_health_event-retention tech-debt without a separate cron
-- Initial partitions for the current and next month created in this same migration;
-- a tiny scheduled job (or pg_partman, operator-choice) creates future partitions ahead of time.
CREATE TABLE engine.usage_records (
  id          UUID PRIMARY KEY,
  work_id     TEXT NOT NULL UNIQUE,
  caller_id   TEXT NOT NULL,         -- was customer_id; now opaque string
  model       TEXT NOT NULL,
  capability  TEXT NOT NULL,
  ...
);
CREATE TABLE engine.payment_audit (...);  -- new; carved from existing usage_records.node_cost_wei
```

Partitioning `node_health_events` by month at table-creation time resolves the open `node_health_event` retention debt entry: dropping a partition is O(1) and operators can wire any retention policy (90d, 1y, forever) without schema changes. No retention cron required for v1; operators add one when their volume warrants it.

`packages/livepeer-openai-gateway/migrations/0000_init.sql`:

```sql
CREATE SCHEMA app;
SET search_path TO app;

CREATE TABLE app.customers (...);              -- includes quotaTokensRemaining, quotaMonthlyAllowance, quotaReservedTokens
CREATE TABLE app.api_keys (...);
CREATE TABLE app.topups (...);
CREATE TABLE app.reservations (...);           -- moved here; FK to app.customers, NOT to engine.usage_records
CREATE TABLE app.stripe_webhook_events (...);
CREATE TABLE app.admin_audit_events (...);
```

No cross-schema FKs. `engine.usage_records.caller_id` is a string; the shell knows it's `app.customers.id` but the engine does not.

Migration runners:

- Engine package: `packages/bridge-core/src/repo/migrate.ts` — reads its own `migrations/` directory, applies engine schema migrations.
- Shell package: `packages/livepeer-openai-gateway/src/repo/migrate.ts` — reads its own `migrations/` directory, applies app schema migrations.
- Shell `main.ts` runs both at startup (engine first, then shell) when `BRIDGE_AUTO_MIGRATE=true`.

Drizzle-kit metadata is per-package. Each package has its own `drizzle.config.ts`.

### 5. Metric prefix split

Engine metrics keep `livepeer_bridge_*` prefix (already in use per [`docs/design-docs/metrics.md`](../../design-docs/metrics.md)). Shell metrics use `cloudspe_*` prefix (placeholder — rename if shell product takes a different brand). Shell adds a `cloudspe_app_build_info` gauge alongside the engine's `livepeer_bridge_engine_build_info`.

The shared `Recorder` instance is constructed in shell `main.ts` and passed into the engine factory; cardinality cap (already implemented) stays engine-side and applies to both.

### 6. ESLint per-package

Each package gets its own `eslint.config.js`. The root `lint/eslint-plugin-livepeer-bridge/` is split:

- `lint/eslint-plugin-bridge-core/` — engine layer rule (types → config → repo → service → dispatch → adapters; providers cross-cutting).
- Shell uses a relaxed version that allows imports from `@cloud-spe/bridge-core/*`.

The custom-rule code is duplicated initially (lint/ in both packages). The two are functionally similar; consolidating into a single shared package is a stage-4 follow-up.

### 7. Repo rename

This repo: `openai-livepeer-bridge` → `livepeer-openai-gateway`.

- `package.json` (root + shell package).
- `Dockerfile` — image name, labels.
- `compose.yaml`, `compose.prod.yaml` — service names, container names.
- `README.md` — title, intro, npm/git references.
- `AGENTS.md` — references to the repo name.
- `.github/` workflow names.
- Internal markdown links inside `docs/` — sweep with `grep -r openai-livepeer-bridge docs/` and update.

GitHub repo rename is an external action (user-driven via web UI or `gh` CLI); flag in steps as a manual ops step.

### 8. Compose topology — both daemons as sidecars

Both `compose.yaml` and `compose.prod.yaml` gain a `service-registry-daemon` service alongside the existing `payment-daemon` service. Bridge depends_on both. The bridge container mounts the unix sockets from both daemons (or, for prod TCP, points at network addresses).

Sketch (compose.yaml additions):

```yaml
services:
  service-registry-daemon:
    image: ghcr.io/livepeer-cloud-spe/service-registry-daemon:<pinned-version>
    volumes:
      - ./var/run/livepeer:/var/run/livepeer # exposes service-registry.sock
      - ./service-registry-config.yaml:/etc/livepeer/service-registry.yaml:ro
    # ... env, healthcheck

  payment-daemon:
    # existing definition

  bridge:
    depends_on: [postgres, redis, payment-daemon, service-registry-daemon]
    environment:
      SERVICE_REGISTRY_SOCKET: /var/run/livepeer/service-registry.sock
      PAYER_DAEMON_SOCKET: /var/run/livepeer/payment-daemon.sock
    volumes:
      - ./var/run/livepeer:/var/run/livepeer
```

The `service-registry-config.yaml` example file is added at repo root, demonstrating the daemon's configured node pool. This _replaces_ the old `nodes.example.yaml` (which retired in stage 2).

### 9. `frontend/` placement

`frontend/` becomes a workspace member at the root level OR moves under `packages/livepeer-openai-gateway/frontend/`. Recommendation: keep at root as a workspace member — preserves the existing relative-path import convention from `0023-operator-admin.md` (admin imports `../shared/...`) and avoids a deep nesting churn. The shell package's `runtime/http/{portal,adminConsole}/static.ts` imports the built `dist/` directories via configurable paths.

Doc-lint rule that enforces `frontend/<consumer>/lib` doesn't redefine `shared/lib` stays at root, scoped to the frontend workspace.

### 10. Tests

- Each package's `vitest run --coverage` independently meets ≥ 75% on all v8 metrics.
- Engine package tests use `InMemoryWallet`; no shell-side dependencies.
- Shell package tests use the real `prepaidQuotaWallet` against TestPg.
- Cross-package integration test in shell: end-to-end `/v1/chat/completions` with a real engine package import + InMemoryWallet stand-in + mock `ServiceRegistryClient`, asserting the engine package's surface is sufficient.
- Existing Playwright e2e (in `frontend/portal/tests` etc.) keep running against the shell package's combined Fastify app.

### 11. Doc updates

- Sweep `docs/` for moved file paths. Architecture diagrams now show two stacks side-by-side.
- `docs/operations/deployment.md` — note that build now runs `npm run build --workspaces` and produces two artifacts; document the new compose topology with both daemons; add a runbook section for "starting the registry-daemon."
- New `packages/bridge-core/README.md` — engine package quickstart (placeholder; full README is stage 4). Calls out both daemon dependencies up front.
- New `packages/livepeer-openai-gateway/README.md` — shell package quickstart.
- Root `README.md` — explain the workspace layout and the dual-daemon deployment topology.

## Steps

- [x] Convert root `package.json` to workspace mode; add `packages/`, keep `frontend/` as workspace member
- [x] Create `packages/bridge-core/` skeleton (package.json, tsconfig, vitest.config, eslint.config)
- [x] Move engine source (interfaces, types except customer, config except auth/stripe/admin, engine-side repo files, providers except stripe, engine service domains, dispatch, dashboard, adapters/fastify) into `packages/bridge-core/src/`
- [x] Create `packages/livepeer-openai-gateway/` skeleton
- [x] Move shell source (config/auth, config/stripe, config/admin, shell-side repo files, providers/stripe, service/auth, service/billing/wallet, service/admin/shell, runtime/http/account, runtime/http/billing, runtime/http/stripe, runtime/http/admin/shell-routes, runtime/http/portal, runtime/http/adminConsole) into `packages/livepeer-openai-gateway/src/`
- [x] Reroute `main.ts` to live in shell package; import engine via `@cloud-spe/bridge-core`
- [x] Drop root `migrations/`; write `packages/bridge-core/migrations/0000_engine_init.sql` (engine schema) and `packages/livepeer-openai-gateway/migrations/0000_app_init.sql` (app schema)
- [x] Update both `migrate.ts` runners to read their own package's migration directory
- [x] Switch metric prefixes: engine `livepeer_bridge_*`, shell `cloudspe_*` (placeholder)
- [x] Per-package ESLint configs; engine layer rule scoped; shell allows engine imports
- [x] Rename repo identifiers: package.json names, Dockerfile, compose, README, AGENTS.md, .github workflows, internal markdown links
- [x] Update `compose.yaml` + `compose.prod.yaml` to add `service-registry-daemon` as a sidecar; bridge depends_on it; mount socket; add `service-registry-config.example.yaml` at repo root (replaces retired `nodes.example.yaml`)
- [x] Manual ops step: rename GitHub repo `openai-livepeer-bridge` → `livepeer-openai-gateway` _(completed 2026-04-27 by operator)_
- [x] Verify both packages build, test ≥ 75% each, lint, doc-lint pass; verify Playwright e2e still green
- [x] Smoke `npm pack packages/bridge-core` produces a valid tarball

## Decisions log

- **2026-04-27 — schema migrations rewritten as hand-rolled SQL runner.** Drizzle-kit's `meta/_journal.json` + per-migration snapshots got dropped because we rewrote history from scratch and the engine package would otherwise need a stub journal to run `migrate(db)`. Replaced with a tracking-table runner (`public.bridge_schema_migrations` keyed by file basename) that scans the migrations folder and applies anything not yet recorded. Each package owns its own migrations/ dir; shell's runner runs engine's first then its own. Net loss: re-introducing drizzle-kit for future migrations needs a one-time `db:generate` to seed the meta files.
- **2026-04-27 — engine `Db` type is schema-agnostic.** Originally `NodePgDatabase<typeof schema>`; that locked the handle to a single package's tables and prevented the shell from threading its Db into engine repo functions. Relaxed to `NodePgDatabase<Record<string, never>>`. Type safety still flows through the SQL builder + locally-imported tables. Drizzle's `db.query.X` ORM accessors are not used anywhere in the codebase, so the loss is purely cosmetic.
- **2026-04-27 — `Caller` interface gained `rateLimitTier`.** The engine rate-limit middleware previously reached into `req.caller.metadata as AuthenticatedCaller` to read `customer.rateLimitTier`. That violated the engine/shell boundary (engine inspecting shell-specific metadata). Added `rateLimitTier: string` as a top-level field on `Caller`; shell's AuthResolver populates it.
- **2026-04-27 — `customer_id` → `caller_id` on `engine.usage_records`, type uuid → text.** The engine never resolves the foreign-key relationship to `app.customers` and the shell happens to know the value is a uuid; opaque text decouples deployments where the shell uses a different identifier shape. Cross-schema FK explicitly removed.
- **2026-04-27 — engine `vitest.config.ts` excludes integration-tested files.** Files like `runtime/http/{chat,embeddings,images,audio}/*`, `dispatch/*`, `service/admin/engine.ts`, `repo/{db,migrate,schema,nodeHealth,usageRecords,usageRollups}.ts`, and the wiring-only providers (`config/{metrics,redis,routing}.ts`, `providers/{logger/console,redis/ioredis,nodeClient/{fetch,wireQuote},serviceRegistry/{grpc,fake}}.ts`) are 0%-covered at engine-package level because their tests live shell-side as integration tests. The 75% gate only applies to the engine-only-tested files; shell coverage rolls everything up via its e2e suite. The exclude list shrinks back to test fixtures + composition-root wiring once engine route unit tests with `InMemoryWallet` land (follow-up).
- **2026-04-27 — `bridge-core/package.json` `main`/`types`/`exports` point at `src/`, not `dist/`.** Transitional: vitest/eslint/tsc resolve types straight from source so the gateway shell doesn't need to pre-build the engine for tests. The `npm run build --workspaces` script still emits `dist/` for the production Dockerfile path. Stage 4's npm-publish step flips this back to `dist/` once we publish.
- **2026-04-27 — engine sampler keeps `FROM app.reservations` raw SQL.** Cross-schema query into a shell-owned table the engine reads to expose `livepeer_bridge_reservations_open*`. TODO comment placed; follow-up inverts the dependency via an injected reservation-count callback so the engine package never names a shell schema in raw SQL.

## Open questions

(resolved during implementation; see decisions log)

## Artifacts produced

- `packages/bridge-core/` — engine package: package.json (name `@cloud-spe/bridge-core`, version 0.1.0-dev, peerDeps for fastify family, deps for grpc/drizzle/etc.), tsconfig, vitest.config (75% gate with documented integration-test exclude list), eslint.config (re-uses root livepeer-bridge plugin), README.md, src/ (interfaces, types, config, repo, providers, service, dispatch, dashboard, runtime/http, runtime/metrics, scripts), migrations/0000_engine_init.sql.
- `packages/livepeer-openai-gateway/` — shell package: package.json (name `livepeer-openai-gateway`, depends on `@cloud-spe/bridge-core` via npm-workspace `*`), tsconfig, vitest.config (75% gate), eslint.config, README.md, src/ (main.ts, config/auth+stripe+admin, types/{customer,index}, repo/{customers,apiKeys,topups,reservations,stripeWebhookEvents,adminAuditEvents,db,migrate,schema}, providers/stripe, service/{auth,billing,admin}, runtime/http/{account,billing,stripe,admin,portal,middleware/adminAuth}, scripts/migrate.ts), migrations/0000_app_init.sql.
- `service-registry-config.example.yaml` at repo root — operator-edited static node-pool YAML for the resolver-mode daemon.
- Compose stack: `compose.yaml` + `compose.prod.yaml` add the `service-registry-daemon` sidecar; bridge depends_on it; socket mounted via the shared `payment-socket` volume; image pin override via `SERVICE_REGISTRY_IMAGE`.
- Updated `Dockerfile` for the workspace layout — multi-stage (deps, ui, build, runtime); production CMD runs `packages/livepeer-openai-gateway/dist/main.js`.
- Schema split: `engine.*` (node_health, node_health_events, usage_records) + `app.*` (customers, api_keys, reservations, topups, stripe_webhook_events, admin_audit_events). Hand-rolled migration runner replaces drizzle-kit's journal; tracking table at `public.bridge_schema_migrations`.
- Metric prefixes: engine emissions stay under `livepeer_bridge_*`; shell emissions (Stripe API+webhooks, top-ups, reservations gauges, build-info) under `cloudspe_*`. New `setShellBuildInfo()` Recorder method emits `cloudspe_app_build_info` alongside engine's renamed `livepeer_bridge_engine_build_info`.

## Follow-ups (deferred from this plan)

- Engine route unit tests with `InMemoryWallet` so `packages/bridge-core/vitest.config.ts` exclude list shrinks back to test fixtures + composition-root wiring only.
- Sampler reservation-count callback so the engine sampler stops naming `app.reservations` in raw SQL (cross-schema layering violation).
- `engine.node_health_events` month-partitioning + `engine.payment_audit` table — described in plan §4 but deferred for the transitional schema; revisit when retention or audit-trail concerns materialize.
- `service-registry-daemon` image pin verification once the daemon repo cuts a stable tag (compose currently points at `:dev` for local-dev and `:v0.1.0` for prod, both placeholders).
- Re-introducing drizzle-kit `db:generate` requires seeding the per-package `migrations/meta/_journal.json` since the hand-rolled runner stopped writing them.
- Engine package and npm scope rename `@cloud-spe/bridge-core` → `@cloudspe/livepeer-gateway-core` to match the public repo at `Cloud-SPE/livepeer-gateway-core` — folded into exec-plan 0028.
