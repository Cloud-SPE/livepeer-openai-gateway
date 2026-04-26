---
id: 0026
slug: engine-extraction-workspace
title: Engine extraction stage 3 — convert to npm workspaces; create packages/bridge-core/ + packages/livepeer-openai-gateway/; split DB schema (engine.* + app.*); rewrite migrations clean; rename this repo
status: active
owner: agent
opened: 2026-04-26
---

## Goal

Stage 3 of a 4-stage extraction. With interfaces ([`0024`](./0024-engine-extraction-interfaces.md)) and dispatchers ([`0025`](./0025-engine-extraction-dispatchers.md)) in place, this stage performs the actual file moves: convert the repo to npm workspaces, create `packages/bridge-core/` (engine) and `packages/livepeer-openai-gateway/` (shell), split the Postgres schema into `engine.*` and `app.*` namespaces, rewrite the migration history clean (nothing is deployed; we drop `migrations/0000-0006.sql` and start fresh per package), split metric-name prefixes, set up per-package ESLint configs, and rename this repo from `openai-livepeer-bridge` to `livepeer-openai-gateway`.

After this stage:
- `packages/bridge-core/` is a self-contained engine package with its own `package.json`, `tsconfig.json`, `vitest.config.ts`, ESLint config, migrations, tests, and dashboard.
- `packages/livepeer-openai-gateway/` is the shell package consuming `bridge-core` via workspace symlink.
- `bridge-ui/` (the entire `shared/`, `portal/`, `admin/` tree) lives under the shell package — it's all shell-owned, both consumers are shell.
- The engine's Fastify peer-dep declaration is real (Fastify is no longer a direct dep of the engine).
- DB has two schemas. Engine writes `engine.usage_records` with `caller_id` (string). Shell writes `app.customers`, `app.api_keys`, `app.topups`, `app.reservations`, `app.stripe_webhook_events`, `app.admin_audit_events`. No cross-schema FKs.
- Each package runs its own migrations independently at startup.
- Metric names are prefixed: engine emits `livepeer_bridge_*`; shell emits `cloudspe_*` (placeholder; rename if a different shell product name is chosen).
- This repo's `package.json`, `Dockerfile`, `compose*.yaml`, `README.md`, internal links, and CI all reflect the new name `livepeer-openai-gateway`.

The engine package can be `npm pack`-ed and installed elsewhere as a tarball, validating the public surface before stage 4 actually publishes it.

## Non-goals

- No public repo creation, no npm publish (stage 4).
- No data migration (nothing is deployed; fresh installs only).
- No additions to engine/shell scope — only mechanical moves of code already classified in stages 1–2.
- No deprecation of the old migration history beyond renumbering — stage 4 is when the public engine repo gets a fresh `0000_init.sql`.
- No changes to dispatcher signatures or adapter interfaces.
- No `@cloud-spe/bridge-core` npm publication yet — workspace consumption only.
- No splitting of `bridge-ui/shared/` between repos. It stays in the shell package; both `portal/` and `admin/` are shell consumers.

## Approach

### 1. Workspace conversion

Root `package.json`:

```jsonc
{
  "name": "livepeer-openai-gateway-monorepo",
  "private": true,
  "workspaces": ["packages/*", "bridge-ui/*"]
}
```

Root retains: `compose*.yaml`, top-level `docs/`, `lint/`, `migrations/` retired, `scripts/` for orchestrating monorepo-wide commands.

Move scripts:
- `npm run build` → workspace-aware: builds `bridge-core` first, then `livepeer-openai-gateway`, then `bridge-ui/*`.
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
│   ├── repo/                   # db.ts, schema.ts (engine tables only), nodeHealth.ts, usageRecords.ts, usageRollups.ts, migrate.ts
│   ├── providers/              # database, http, metrics, nodeClient, payerDaemon, redis, tokenizer, logger (NO stripe)
│   ├── service/                # nodes, payments, routing, pricing, tokenAudit, rateLimit, admin/engine.ts, admin/basicAuthResolver.ts, billing/inMemoryWallet.ts (reference impl only)
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
    ".":          "./dist/index.js",
    "./fastify":  "./dist/adapters/fastify/index.js",
    "./dashboard":"./dist/dashboard/index.js"
  },
  "peerDependencies": {
    "fastify": "^4.29.0",
    "@fastify/static": "^7.0.0",
    "@fastify/multipart": "^8.3.0",
    "@fastify/sensible": "^5.6.0"
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
    "zod": "..."
  }
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
│           ├── portal/         # @fastify/static for bridge-ui/portal
│           └── adminConsole/   # @fastify/static for bridge-ui/admin
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
    "zod": "..."
  }
}
```

### 4. Schema split + migration rewrite

Drop the existing `migrations/0000-0006.sql` from the root. Rewrite from scratch per package — fresh installs only, no data migration.

`packages/bridge-core/migrations/0000_init.sql`:

```sql
CREATE SCHEMA engine;
SET search_path TO engine;

CREATE TABLE engine.nodes (...);
CREATE TABLE engine.node_health_events (...);
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

### 8. `bridge-ui/` placement

`bridge-ui/` becomes a workspace member at the root level OR moves under `packages/livepeer-openai-gateway/bridge-ui/`. Recommendation: keep at root as a workspace member — preserves the existing relative-path import convention from `0023-operator-admin.md` (admin imports `../shared/...`) and avoids a deep nesting churn. The shell package's `runtime/http/{portal,adminConsole}/static.ts` imports the built `dist/` directories via configurable paths.

Doc-lint rule that enforces `bridge-ui/<consumer>/lib` doesn't redefine `shared/lib` stays at root, scoped to the bridge-ui workspace.

### 9. Tests

- Each package's `vitest run --coverage` independently meets ≥ 75% on all v8 metrics.
- Engine package tests use `InMemoryWallet`; no shell-side dependencies.
- Shell package tests use the real `prepaidQuotaWallet` against TestPg.
- Cross-package integration test in shell: end-to-end `/v1/chat/completions` with a real engine package import + InMemoryWallet stand-in, asserting the engine package's surface is sufficient.
- Existing Playwright e2e (in `bridge-ui/portal/tests` etc.) keep running against the shell package's combined Fastify app.

### 10. Doc updates

- Sweep `docs/` for moved file paths. Architecture diagrams now show two stacks side-by-side.
- `docs/operations/deployment.md` — note that build now runs `npm run build --workspaces` and produces two artifacts.
- New `packages/bridge-core/README.md` — engine package quickstart (placeholder; full README is stage 4).
- New `packages/livepeer-openai-gateway/README.md` — shell package quickstart.
- Root `README.md` — explain the workspace layout.

## Steps

- [ ] Convert root `package.json` to workspace mode; add `packages/`, keep `bridge-ui/` as workspace member
- [ ] Create `packages/bridge-core/` skeleton (package.json, tsconfig, vitest.config, eslint.config)
- [ ] Move engine source (interfaces, types except customer, config except auth/stripe/admin, engine-side repo files, providers except stripe, engine service domains, dispatch, dashboard, adapters/fastify) into `packages/bridge-core/src/`
- [ ] Create `packages/livepeer-openai-gateway/` skeleton
- [ ] Move shell source (config/auth, config/stripe, config/admin, shell-side repo files, providers/stripe, service/auth, service/billing/wallet, service/admin/shell, runtime/http/account, runtime/http/billing, runtime/http/stripe, runtime/http/admin/shell-routes, runtime/http/portal, runtime/http/adminConsole) into `packages/livepeer-openai-gateway/src/`
- [ ] Reroute `main.ts` to live in shell package; import engine via `@cloud-spe/bridge-core`
- [ ] Drop root `migrations/`; write `packages/bridge-core/migrations/0000_init.sql` (engine schema) and `packages/livepeer-openai-gateway/migrations/0000_init.sql` (app schema)
- [ ] Update both `migrate.ts` runners to read their own package's migration directory
- [ ] Switch metric prefixes: engine `livepeer_bridge_*`, shell `cloudspe_*` (placeholder)
- [ ] Per-package ESLint configs; engine layer rule scoped; shell allows engine imports
- [ ] Rename repo identifiers: package.json names, Dockerfile, compose, README, AGENTS.md, .github workflows, internal markdown links
- [ ] Manual ops step: rename GitHub repo `openai-livepeer-bridge` → `livepeer-openai-gateway`
- [ ] Verify both packages build, test ≥ 75% each, lint, doc-lint pass; verify Playwright e2e still green
- [ ] Smoke `npm pack packages/bridge-core` produces a valid tarball

## Decisions log

(empty)

## Open questions

(none at plan-write time)

## Artifacts produced

(empty until in-flight)
