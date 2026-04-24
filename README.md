# openai-livepeer-bridge

An OpenAI-compatible API service that fronts a pool of Livepeer WorkerNodes. Customers pay in USD (prepaid balance + free tier); the service pays nodes via the `livepeer-payment-library` daemon.

> **This is an agent-first repository.** Before making changes, start with [AGENTS.md](AGENTS.md) → [DESIGN.md](DESIGN.md) → [docs/design-docs/](docs/design-docs/).

## What it does

- Accepts OpenAI SDK calls (custom `base_url` + API key we issue)
- `/v1/chat/completions` streaming + non-streaming (v1)
- Free tier (quota-capped) + Prepaid tier (USD balance, Stripe top-ups)
- Routes to a Livepeer WorkerNode; bills the customer in USD; pays the node in ETH via probabilistic micropayments

## Status

v1 feature-complete — all twelve product exec-plans (0001–0012) plus the deployment bootstrap (0013) are in `docs/exec-plans/completed/`. Outstanding work is tracked in [docs/exec-plans/tech-debt-tracker.md](docs/exec-plans/tech-debt-tracker.md).

## Run locally

### With Docker (recommended)

```
cp .env.example .env
# fill in REQUIRED values in .env (API_KEY_PEPPER, STRIPE_*, ADMIN_TOKEN, …)
cp docs/references/openai-bridge-architecture.md nodes.yaml.example   # reference only
# author your own nodes.yaml — see docs/design-docs/node-lifecycle.md
docker compose up --build
```

The stack brings up:

- `postgres:16-alpine` (bridge's ledger)
- `redis:7-alpine` (rate-limit + cache)
- `bridge` (this repo, built from `Dockerfile`)

The PayerDaemon is **not** included by default — it lives in a sibling repo ([`livepeer-payment-library`](../livepeer-payment-library)) and runs as a sidecar. Mount its unix socket into the shared `payer-socket` volume at `/run/payer-daemon/daemon.sock`. See the commented `payer-daemon` block in `compose.yaml` for the expected wiring; uncomment once the library publishes an image.

### Without Docker

```
npm ci
npm run build
# point env vars at running Postgres + Redis (and a payer daemon socket)
npm run start
```

`npm run start` runs `dist/main.js` which loads every env-based config, constructs every provider, applies migrations if `BRIDGE_AUTO_MIGRATE=true` (default), and starts Fastify on `HOST:PORT` (default `0.0.0.0:8080`).

## Endpoints

### Customer-facing (`Authorization: Bearer <api-key>`)

| Method | Path                   | Purpose                                                      |
| ------ | ---------------------- | ------------------------------------------------------------ |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat; `stream=true` for SSE                |
| `POST` | `/v1/billing/topup`    | Create a Stripe Checkout Session                             |
| `POST` | `/v1/stripe/webhook`   | Stripe webhook receiver (signature-verified, no auth header) |

### Operator (`X-Admin-Token: <ADMIN_TOKEN>`)

See [`docs/product-specs/admin-endpoints.md`](docs/product-specs/admin-endpoints.md):

- `GET /admin/health`, `/admin/nodes`, `/admin/nodes/:id`, `/admin/customers/:id`, `/admin/escrow`
- `POST /admin/customers/:id/refund`, `/suspend`, `/unsuspend`

### Probes (no auth)

- `GET /healthz` — liveness probe used by Dockerfile/compose healthchecks.

## Development

```
npm run test           # vitest + coverage gate (≥ 75% on every metric)
npm run test:watch     # interactive vitest
npm run typecheck      # tsc --noEmit
npm run lint           # eslint + custom layer-check
npm run fmt            # prettier --write
npm run db:generate    # drizzle-kit: regenerate migrations from schema
npm run db:migrate     # apply migrations
npm run proto:gen      # regenerate PayerDaemon TS stubs from the library proto
```

Tests require a Postgres + Redis reachable either via Testcontainers (Docker running locally) or via `TEST_PG_HOST` / `TEST_REDIS_HOST` env vars (CI uses GitHub Actions service containers).

## License

MIT (TBD at first release).
