---
id: 0013
slug: deployment-bootstrap
title: Process entrypoint, Dockerfile, docker-compose
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Make the bridge runnable. Today it has no way to start a long-running process — tests assemble mini-stacks, but `package.json` has no `start` script, `src/main.ts` doesn't exist, and there is no Dockerfile or compose file. 0013 fixes all three: a single process entrypoint that wires every provider + service + route, a multi-stage Dockerfile, a `compose.yaml` for local dev (bridge + Postgres + Redis, with the PayerDaemon documented as an external sidecar), a public `/healthz`, graceful shutdown, and a `.env.example`.

Depends on: every prior plan (consumes every config loader + provider).

## Non-goals

- K8s manifests / Helm chart.
- CI workflow that builds + pushes images to a registry.
- Secret-manager integration (plain env for v1; already logged in 0004 tech-debt).
- Cross-repo Docker build of the PayerDaemon binary — documented as an external sidecar; `compose.yaml` shows where it plugs in but does not build it.

## Approach

- [x] Public `GET /healthz` — `src/runtime/http/healthz.ts`; returns `{ok: true}` with no auth.
- [x] `src/main.ts` — loads every config, constructs every provider, registers every route (`/healthz`, `/v1/chat/completions`, `/v1/billing/topup`, `/v1/stripe/webhook`, `/admin/*`), applies migrations when `BRIDGE_AUTO_MIGRATE=true`, starts the QuoteRefresher + PayerDaemon health loop, handles SIGTERM / SIGINT with a 30 s grace window.
- [x] `npm run start` → `node dist/main.js`.
- [x] Multi-stage `Dockerfile` — `deps` (`npm ci`) → `build` (tsc + prod-prune) → `gcr.io/distroless/nodejs20-debian12` runtime. Non-root by default (distroless).
- [x] `.dockerignore` excluding `docs/`, `node_modules/`, tests, git metadata.
- [x] `compose.yaml` — `bridge + postgres:16-alpine + redis:7-alpine`; shared `payer-socket` named volume + commented-out `payer-daemon` service block that documents the expected wiring.
- [x] `.env.example` covering every env var across `src/config/`.
- [x] README "Run locally" section (Docker + non-Docker), endpoint index, dev script reference.
- [x] Unit test for `/healthz`.
- [x] `vitest.config.ts` excludes `src/main.ts` from coverage.

## Decisions log

### 2026-04-24 — Runtime image: `gcr.io/distroless/nodejs20-debian12`

Reason: smaller than alpine for Node (~70 MB vs ~150 MB), no shell in the runtime = tighter attack surface. Build stage uses `node:20-alpine` for `npm ci` + `tsc`; only the dist + prod node_modules are copied into the final stage.

### 2026-04-24 — Migrations on boot, toggled by `BRIDGE_AUTO_MIGRATE` (default `true`)

Reason: Simpler ops for single-replica soft launch; `npm run start` just works after `docker compose up`. Multi-replica deployments set `BRIDGE_AUTO_MIGRATE=false` and run a one-shot migration job separately — documented in the README and the tech-debt tracker flags the "boot race" (two replicas migrating at once) for when we need it.

### 2026-04-24 — PayerDaemon is an external sidecar; `compose.yaml` does not build it

Reason: The daemon lives in a sibling repo (`livepeer-payment-library`) and is Go-built. A cross-repo Docker build via `context: ../livepeer-payment-library` couples the bridge's compose file to a path that only exists in the cloud-spe workspace. Instead: compose.yaml provisions a shared named volume for the socket (`payer-socket:/run/payer-daemon`), documents the expected daemon mount point, and keeps a commented service block. When the payment library publishes an image, uncommenting + pointing at that image is the one-line change.

### 2026-04-24 — Public `/healthz` (no auth) separate from `/admin/health`

Reason: `/admin/health` requires the admin token and performs deep checks. Dockerfile / compose health probes don't have the token and shouldn't do deep checks anyway — they verify the process is alive and listening. `/healthz` returns `{ok:true}` with no side effects.

### 2026-04-24 — Graceful shutdown window: 30 s

Reason: SIGTERM handler stops the QuoteRefresher + PayerDaemon health loop, closes the HTTP server, then closes each provider (daemon, redis, db pool, tokenizer). 30 s is enough for in-flight streams to drain under `forceCloseConnections: true`; longer and orchestrators (compose, K8s default) hard-kill us anyway.

### 2026-04-24 — `src/main.ts` excluded from coverage

Reason: Assembly-only file (config loading + provider construction + listen). Unit-testing it would mean mocking every provider; integration coverage of the whole process belongs to an ops smoke-test plan, not `npm test`. All the individual pieces it wires are already covered by unit + integration tests.

## Open questions

- Prod logging: Fastify's built-in pino logger is off in tests; main.ts enables it (`logger: true`). Log-level env knob (`LOG_LEVEL=info|debug|warn`) is a small follow-up.
- Registry for images (Docker Hub / GHCR / private) — ops decision; no choice made here.

## Artifacts produced

- `src/runtime/http/healthz.ts` + `src/runtime/http/healthz.test.ts` — public liveness probe.
- `src/main.ts` — single process entrypoint (excluded from coverage).
- `package.json` — `"start": "node dist/main.js"`.
- `Dockerfile` — multi-stage, distroless runtime, exposes 8080, non-root.
- `.dockerignore` — keeps build context trim.
- `compose.yaml` — bridge + postgres + redis, shared socket volume, commented payer-daemon block.
- `.env.example` — every env var, with REQUIRED markers on the three secrets (`API_KEY_PEPPER`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN`).
- `README.md` — rewrote the "Status" and added "Run locally", endpoint index, and dev-script sections.
- `.gitignore` — added `nodes.yaml` (operator-authored; not committed).
- Tests (223 total passing, 1 new for 0013; 91.35% stmt / 80.33% branch / 94.93% func / 91.35% line).
- Tech-debt: multi-replica migration race; Testcontainers port race in parallel test runs; payer-daemon image from the library repo; CI workflow to build + push bridge image.
