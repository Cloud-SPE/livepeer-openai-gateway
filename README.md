# openai-livepeer-bridge

An OpenAI-compatible API service that fronts a pool of Livepeer WorkerNodes. Customers pay in USD (prepaid balance + free tier); the service pays nodes in ETH via the [`livepeer-payment-library`](../livepeer-payment-library) daemon running as a sidecar.

> **Agent-first repository.** Before making changes, read [AGENTS.md](AGENTS.md) → [DESIGN.md](DESIGN.md) → [docs/design-docs/](docs/design-docs/). Non-trivial work starts with an exec-plan in `docs/exec-plans/active/`; see [PLANS.md](PLANS.md).

## What it does

- **OpenAI-compatible `/v1/chat/completions`** — streaming (SSE) + non-streaming. Drop-in compatible with the official `openai` SDK via a custom `base_url` + an API key the bridge issues.
- **Two customer tiers**: **Free** (100K-token monthly quota) and **Prepaid** (USD balance, topped up via Stripe Checkout). First top-up auto-upgrades a free customer atomically with the credit.
- **Routes every request** to a Livepeer WorkerNode from a config-driven pool, builds a micropayment via `PayerDaemon`, forwards the call, commits billing from the node's reported usage.
- **Fail-closed on payment-daemon outage.** Never proceeds without payment.
- **Observation-only token audit**: `tiktoken`-based local counts cross-checked against node-reported counts; drift is metered, not enforced.
- **Operator endpoints** under `/admin/*` for health, node inspection, customer lookup, manual refund, suspend/unsuspend, escrow view.

## Status

**v1 feature-complete.** All sixteen exec-plans (0001 – 0016) are in [`docs/exec-plans/completed/`](docs/exec-plans/completed/). Outstanding items are durable — each is an entry in [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md).

| Plan | What it ships                                                        |
| ---: |----------------------------------------------------------------------|
| 0001 | Repo scaffolding, toolchain                                          |
| 0002 | Zod domain types + 75% coverage gate                                 |
| 0003 | CustomerLedger: atomic reserve/commit/refund, FOR UPDATE row locks   |
| 0004 | AuthLayer: HMAC-SHA-256 API keys, Fastify preHandler                 |
| 0005 | NodeBook: config loader, QuoteRefresher, circuit breaker             |
| 0006 | PayerDaemon gRPC client + session cache                              |
| 0007 | `/v1/chat/completions` non-streaming (end-to-end)                    |
| 0008 | `/v1/chat/completions` streaming + retry policy                      |
| 0009 | Redis sliding-window rate limiter + concurrency semaphore            |
| 0010 | Stripe Checkout top-ups + signed webhook + tier upgrade              |
| 0011 | LocalTokenizer (metric-only)                                         |
| 0012 | Admin / ops endpoints                                                |
| 0013 | Process entrypoint, Dockerfile, docker-compose                       |
| 0014 | Architectural ESLint plugin (layer-check et al.)                     |
| 0015 | doc-gardener, proto-drift, secret-scan                               |
| 0016 | Production docker stack (`tztcloud/livepeer-payment-daemon:v0.8.10`) |

Test suite: **223 tests, 91 % statement / 80 % branch coverage** (the 75 % floor is mechanically enforced per [core belief #11](docs/design-docs/core-beliefs.md)).

## Where things live

```
src/
├── types/          Zod schemas + inferred TS types (src/types/*.ts)
├── config/         Zod-validated env loaders (one file per concern)
├── providers/      Cross-cutting I/O deps — the ONLY layer that may import
│                   pg, ioredis, stripe, @grpc/*, fastify, tiktoken, viem, pino.
│                   Interface in providers/<name>.ts; default impl in
│                   providers/<name>/<backend>.ts.
├── repo/           Typed DB access (Drizzle). Primitive reads/writes, no
│                   business logic.
├── service/        Business logic: auth, billing, routing, pricing,
│                   nodes, payments, rateLimit, tokenAudit, admin.
├── runtime/        HTTP surface: route registrations, preHandlers, error
│                   envelope mapping. Only layer that speaks Fastify shape.
└── main.ts         Single process entrypoint — wires every config +
                    provider + service + route, runs migrations, handles
                    SIGTERM.

docs/
├── design-docs/    Durable architectural decisions. See index.md for the
│                   catalog; every file has {title, status, last-reviewed}.
├── product-specs/  Customer-facing + operator-facing behavior (topup flow,
│                   admin endpoints, etc.).
├── exec-plans/
│   ├── active/     In-flight work (empty in v1).
│   ├── completed/  Every plan that shipped, with its decisions log and
│                   artifacts — history is immutable.
│   └── tech-debt-tracker.md  Append-only list of open items with remediation.
├── generated/      Auto-generated; do not hand-edit.
├── operations/     Operator guides — deployment, runbooks.
└── references/     External material — architecture reference, harness PDFs.

migrations/         Drizzle-generated Postgres migrations.
lint/
├── eslint-plugin-livepeer-bridge/  Six custom ESLint rules (0014).
└── doc-gardener/                    Docs-integrity lint (0015).

Dockerfile, compose.yaml, compose.prod.yaml, .env.example, .gitleaks.toml  — deployment (0013, 0015, 0016).
```

## Invariants (non-negotiable)

From [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md) and [`AGENTS.md`](AGENTS.md):

1. **Customer never sees wei.** All customer-facing units are USD or tokens.
2. **Zod at boundaries.** Every HTTP body + every gRPC response parses through a Zod schema before entering `service/`.
3. **Providers boundary.** Cross-cutting libraries only in `src/providers/`.
4. **Atomic ledger debits.** Customer debits run under `SELECT … FOR UPDATE`. No read-modify-write.
5. **Fail-closed on PayerDaemon outage** → 503. Never bill without payment.
6. **Test coverage ≥ 75 %** on lines, branches, functions, statements. Ratchet only up.

ESLint rules [`livepeer-bridge/layer-check`](lint/eslint-plugin-livepeer-bridge/rules/layer-check.js), [`no-cross-cutting-import`](lint/eslint-plugin-livepeer-bridge/rules/no-cross-cutting-import.js), and [`zod-at-boundary`](lint/eslint-plugin-livepeer-bridge/rules/zod-at-boundary.js) enforce the first three mechanically.

## Run locally

### With Docker (recommended)

```sh
cp .env.example .env
# fill the REQUIRED values: CHAIN_RPC, API_KEY_PEPPER, STRIPE_*, ADMIN_TOKEN
# drop keystore.json + keystore-password alongside compose.yaml (see .env.example)
# author your own nodes.yaml — see docs/design-docs/node-lifecycle.md
docker compose up --build
```

Stands up `postgres:16-alpine` + `redis:7-alpine` + `tztcloud/livepeer-payment-daemon:v0.8.10` (sender mode) + the bridge (built from `Dockerfile`). All four services share a `payment-socket` named volume at `/var/run/livepeer/` so the bridge can reach the daemon over its unix socket.

See [`docs/operations/deployment.md`](docs/operations/deployment.md) for the full walkthrough including the production override (`compose.prod.yaml`) with pinned image, restart policies, log rotation, resource limits, read-only hardening, and the one-shot migration job.

### Without Docker

```sh
npm ci
npm run build
# export env vars pointing at a running Postgres + Redis + PayerDaemon socket
npm run start
```

`npm run start` invokes `dist/main.js`: Zod-validated env, every provider constructed, `/healthz` + `/v1/chat/completions` + `/v1/billing/topup` + `/v1/stripe/webhook` + `/admin/*` registered, migrations applied on boot unless `BRIDGE_AUTO_MIGRATE=false`, Fastify listening on `${HOST}:${PORT}` (default `0.0.0.0:8080`).

## Endpoints

### Customer (`Authorization: Bearer <api-key>`)

| Method | Path                   | Purpose                                                                                                                                                                         |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat; `stream=true` for SSE. See [`streaming-semantics.md`](docs/design-docs/streaming-semantics.md) + [`retry-policy.md`](docs/design-docs/retry-policy.md). |
| `POST` | `/v1/billing/topup`    | Create a Stripe Checkout Session. See [`topup-prepaid.md`](docs/product-specs/topup-prepaid.md).                                                                                |
| `POST` | `/v1/stripe/webhook`   | Stripe webhook receiver (signature-verified, no auth header).                                                                                                                   |

### Operator (`X-Admin-Token: <ADMIN_TOKEN>`)

Full spec in [`docs/product-specs/admin-endpoints.md`](docs/product-specs/admin-endpoints.md):

- `GET /admin/health`, `/admin/nodes`, `/admin/nodes/:id`, `/admin/customers/:id`, `/admin/escrow`
- `POST /admin/customers/:id/refund`, `/suspend`, `/unsuspend`

### Probes (no auth)

- `GET /healthz` — liveness probe used by the Dockerfile / compose healthcheck.

## Development

```sh
npm run test           # vitest + coverage gate (≥ 75 %)
npm run test:watch     # interactive vitest
npm run test:nocov     # vitest without coverage (fast iterate)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (+ 6 architectural rules from 0014)
npm run doc-lint       # docs integrity (frontmatter, status/location, links)
npm run proto:check    # regenerate protobuf stubs and assert no drift
npm run fmt            # prettier --write
npm run fmt:check      # prettier --check
npm run db:generate    # drizzle-kit: regenerate migrations from schema
npm run db:migrate     # apply migrations (also runs on boot)
npm run proto:gen      # regenerate PayerDaemon TS stubs from sibling proto
```

Tests need Postgres + Redis reachable either via **Testcontainers** (Docker running locally) or via `TEST_PG_HOST` / `TEST_REDIS_HOST` env vars (CI uses GitHub Actions service containers).

## License

MIT (TBD at first release).
