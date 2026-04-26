---
title: Deployment — full-stack docker compose
status: accepted
last-reviewed: 2026-04-26
---

# Deployment

How to run the bridge + payment daemon + postgres + redis stack end-to-end, for both local development and production-shaped deploys.

## Prerequisites

- Docker 20.10+ with Buildkit (Compose v2).
- A V3 JSON Ethereum keystore for the signer wallet. If you don't have one, the payment library's docker guide (`livepeer-payment-library/docs/operations/running-with-docker.md`) explains how to generate one with `geth account new`.
- A funded EVM RPC endpoint for the chain you're running on. Arbitrum One is the default (only `CHAIN_RPC` needs to be set); any other chain requires the full override block (see `.env.example`).
- Stripe test keys (for dev) or live keys (for prod), plus a webhook signing secret.

## Layout

- `compose.yaml` — dev stack: bridge (inline build), postgres, redis, `tztcloud/livepeer-payment-daemon:v0.8.10`.
- `compose.prod.yaml` — prod override: pinned bridge image, restart policies, log rotation, resource limits, read-only hardening on the daemon, one-shot migration job.

Dev invokes one file; prod layers both:

```bash
# dev
docker compose up --build

# prod
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

## Dev walkthrough

```bash
# 1. Secrets & config
cp .env.example .env
$EDITOR .env   # fill every REQUIRED-* placeholder + CHAIN_RPC

# Note: BRIDGE_ETH_ADDRESS must match the address derived from the
# keystore you mount in step 2. The bridge sends it as ?sender= when
# probing worker /quote + /quotes.

# 2. Keystore (signer) + password
cp /path/to/your-v3-keystore.json ./keystore.json
printf '%s' 'your-keystore-password' > ./keystore-password
chmod 600 ./keystore-password

# 3. Nodes allowlist (start from the annotated example)
cp nodes.example.yaml nodes.yaml
$EDITOR nodes.yaml   # edit URLs, ETH addresses, supportedModels, capabilities

# 4. Boot
docker compose up --build
```

The bridge is now at `http://localhost:8080`. Health checks:

- `GET /healthz` — liveness.
- `GET /readyz` — readiness (DB, Redis, payer-daemon socket).

Seed an API key (and tail the bridge logs in another shell):

```bash
# Inside the bridge container — or use a matching psql client from the host.
docker compose exec postgres psql -U bridge -d bridge \
  -c "INSERT INTO customers (id, email, tier) VALUES ('c_dev', 'dev@example.com', 'free');"
```

See `docs/product-specs/` for the full API key / customer / billing lifecycles.

## Issuing the first admin / smoke API key

In production, customers come into existence implicitly via Stripe checkout — the webhook handler creates a `customers` row and issues an API key on the first successful checkout. For **operator-issued** keys (the very first admin key, smoke-test keys, manually-provisioned customer keys), there is currently no HTTP endpoint that exposes `service/auth.issueKey`. Operators have to drop into SQL.

This is a documented workaround, not the long-term answer — tracked as `admin-issue-customer-key-endpoint` in `docs/exec-plans/tech-debt-tracker.md`. Once the endpoint lands, this section will be replaced with a `curl` recipe.

The recipe used during the first mainnet deploy:

### 1. Generate a key suffix

```bash
KEY_SUFFIX=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
echo "API key plaintext: sk-test-${KEY_SUFFIX}"
```

The `tr` pipeline converts standard base64 to URL-safe base64 and strips padding so the resulting key is safe to copy/paste through any tool. Save the plaintext immediately — the database stores only the hash; you cannot recover the plaintext later.

(Use `sk-live-` for production tier, `sk-test-` for a smoke / staging key. The prefix has no semantic meaning to the bridge — it's a customer-facing convention.)

### 2. Compute the HMAC hash

```bash
API_KEY_PEPPER='<the value of API_KEY_PEPPER from the bridge .env>'
HASH=$(printf '%s' "sk-test-${KEY_SUFFIX}" | \
  openssl dgst -sha256 -hmac "$API_KEY_PEPPER" -binary | \
  xxd -p -c 256)
echo "API key hash: ${HASH}"
```

The bridge stores `sha256_hmac(plaintext, API_KEY_PEPPER)` as a hex string. The pepper is the same one the bridge uses at request time to verify incoming keys; rotating it invalidates every key in the table, so plan rotations carefully.

### 3. Insert the customer + key

```bash
docker compose exec postgres psql -U bridge -d bridge <<SQL
-- Adjust id / email / tier to taste. tier ∈ ('free','prepaid','admin').
INSERT INTO customers (id, email, tier)
VALUES ('c_smoke_admin', 'ops@example.com', 'admin');

-- Replace 'sk-test-${KEY_SUFFIX}' below with the real plaintext from step 1
-- if you want the prefix to match for human-eyeballing the row; the
-- key_prefix column is a convenience, not a uniqueness constraint.
INSERT INTO api_keys (id, customer_id, key_prefix, key_hash, env)
VALUES (
  'ak_' || substr(md5(random()::text), 1, 16),
  'c_smoke_admin',
  'sk-test',
  '${HASH}',
  'test'
);
SQL
```

### 4. Verify

```bash
curl -H "Authorization: Bearer sk-test-${KEY_SUFFIX}" \
     http://localhost:8080/v1/models
```

A 200 with the model list confirms the key is live. A 401 means either the hash didn't match (wrong pepper) or the customer / key row didn't insert.

### Caveats

- The `api_keys` schema may evolve — re-confirm column names against the current migration in `migrations/` before pasting into a new environment.
- `API_KEY_PEPPER` rotation invalidates every key in the table; treat it like a database-level secret.
- The `tier` enum is currently `free | prepaid | admin`; admin tier is unmetered and bypasses rate limiting (defined in `service/auth/`).

## Building the production image

Dev (`compose.yaml`) builds inline via `build: { context: . }` — `docker compose up --build` does the right thing for local iteration. Prod (`compose.prod.yaml`) is the opposite — it consumes a pre-built `${BRIDGE_IMAGE}` and refuses to build itself, so operators ship the image themselves.

Three npm scripts wrap the `docker build / tag / push` cycle so the recipe is in-repo and consistent across operators:

```bash
npm run docker:build       # → openai-livepeer-bridge:local
npm run docker:tag         # → tztcloud/livepeer-openai-gateway:v0.8.10
npm run docker:push        # pushes the tag above
```

Or in one shot:

```bash
npm run docker:release     # build + tag + push, in order
```

### Overriding the version

Two equivalent ways to override the default `v0.8.10`:

```bash
# Positional arg (repeats — pass to both tag and push)
npm run docker:tag -- v0.8.11
npm run docker:push -- v0.8.11

# Or via env (no -- needed; sticks for the whole shell)
BRIDGE_VERSION=v0.8.11 npm run docker:tag
BRIDGE_VERSION=v0.8.11 npm run docker:push
```

### Overriding the registry

Default repo path is `tztcloud/livepeer-openai-gateway` (matches `compose.prod.yaml`'s `BRIDGE_IMAGE` default). Override per-operator:

```bash
BRIDGE_IMAGE_REPO=ghcr.io/example/livepeer-bridge npm run docker:tag
BRIDGE_IMAGE_REPO=ghcr.io/example/livepeer-bridge npm run docker:push
```

The push assumes you're already authenticated to the registry (`docker login` for Docker Hub, or `docker login ghcr.io` for GitHub Container Registry). Authentication is operator-side; the scripts don't manage credentials.

### CI hookup

Manual recipe today, CI workflow later. A future GitHub Actions workflow can wrap the same npm scripts on tag push:

```yaml
# .github/workflows/release.yml — sketch, not committed
- run: npm ci
- run: npm test
- run: npm run docker:build
- uses: docker/login-action@v3
  with: { ... }
- run: BRIDGE_VERSION=${GITHUB_REF_NAME} npm run docker:release
```

Tracked as [`tech-debt`](../exec-plans/tech-debt-tracker.md) — local recipe is in place; the workflow is the remaining gap.

## Prod walkthrough

Additional prerequisites:

- A tagged, pushed bridge image — see "Building the production image" above. Set `BRIDGE_IMAGE` in `.env` to whatever you tagged (`tztcloud/livepeer-openai-gateway:v0.8.10` by default).
- Rotate every `REQUIRED-*` placeholder in `.env` to a live value (especially `API_KEY_PEPPER`, `ADMIN_TOKEN`, Stripe live keys).

Boot:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
docker compose -f compose.yaml -f compose.prod.yaml logs -f bridge
```

The `bridge-migrate` service runs once on stack start, applies migrations, and exits `0`. The bridge waits for it via `depends_on: {condition: service_completed_successfully}`, so the first `up` has a ~10-second gap before the bridge comes online. Subsequent `up` invocations short-circuit (the migration job exits immediately on a clean DB).

### Multi-replica notes

- `BRIDGE_AUTO_MIGRATE=false` is set by the prod override. Do not flip it back to `true` in a multi-replica deploy — the migration race is documented in `docs/exec-plans/tech-debt-tracker.md`.
- To scale: `docker compose -f compose.yaml -f compose.prod.yaml up -d --scale bridge=3`. The rate limiter and auth cache are Redis-backed, so replicas coordinate correctly.
- The payer daemon is **not** horizontally scalable (single signer, single socket). Run one per host, or rethink the topology.

## Troubleshooting

### `payer-daemon` exits immediately

Most common: the keystore password file doesn't match the V3 JSON's encryption password, or either file is empty. Check:

```bash
docker compose logs payment-daemon
# look for: "load keystore: ... could not decrypt key with given password"
```

`printf '%s' ...` is safer than `echo` for the password file (no trailing newline).

### `chain id mismatch: endpoint reports X, --expected-chain-id Y`

`CHAIN_RPC` points at a chain whose ID doesn't match what the daemon expects. Arbitrum One is 42161; mainnet is 1. For non-Arbitrum chains you must uncomment the full override block in both `.env` and `compose.yaml` together (chain ID + three contract addresses).

### Bridge logs `PayerDaemonUnavailableError` on every request

The bridge can't reach the daemon's unix socket. Check the shared volume:

```bash
docker compose exec bridge ls -la /var/run/livepeer/
# expect: srwxrwx--- ... payment.sock  (daemon's uid 65532)

docker compose exec payment-daemon ls -la /var/run/livepeer/
# same file, from the daemon's side
```

If the socket is absent, the daemon crashed on boot — check its logs. If it's present but the bridge gets `EACCES`, the two containers disagree on uid. Both `tztcloud/livepeer-payment-daemon` and distroless-nodejs20 default to uid `65532`; don't override `user:` unless you've aligned both.

### Bridge can't connect to postgres

Check ordering:

```bash
docker compose ps
# bridge should be healthy; postgres should be healthy
```

If postgres is unhealthy, the `pg_isready` healthcheck is failing — likely a stale `pgdata` volume with a different superuser password. `docker compose down -v` wipes volumes (dev only; never in prod).

### Migration job fails

```bash
docker compose -f compose.yaml -f compose.prod.yaml logs bridge-migrate
```

Most common: `PGPASSWORD` differs between what postgres was initialised with (in `pgdata` volume) and what's now in `.env`. If you've rotated the password without recreating the volume, the migration job can't connect. Recreate the volume (non-prod only) or rotate the DB's password through SQL.

## Observability

The bridge exposes a Prometheus exposition endpoint on a SEPARATE Fastify
listener from the customer-facing one. Customer traffic and scraper traffic
are independent — a misconfigured scraper cannot break customer traffic, and
the metrics surface has no auth, body limits, or middleware on purpose.

Enable by setting `METRICS_LISTEN` (see `.env.example` for the format and the
recommended port). Leave it unset to disable the listener entirely; the
bridge falls back to a `NoopRecorder` and emits nothing.

```env
# 127.0.0.1 only — Prometheus exposition has no auth.
# See livepeer-modules-conventions/port-allocation.md (recommended :9602).
METRICS_LISTEN=127.0.0.1:9602
METRICS_MAX_SERIES_PER_METRIC=10000
```

Important — bind 127.0.0.1 or an internal-LAN interface only. The
exposition endpoint is unauthenticated; exposing it on a public interface
leaks operational details (latency, RPC counts, deposit/reserve wei) and
gives an attacker a precise health signal. Reverse-proxy scraper traffic over
the cluster network if Prometheus runs elsewhere.

Sample Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: livepeer-bridge
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:9602']
        labels:
          service: livepeer-bridge
    scrape_interval: 30s
    scrape_timeout: 10s
```

All emitted series live under the `livepeer_bridge_` namespace. The recorder
contract (`src/providers/metrics/recorder.ts`) is the catalog — every method
name maps to one Prometheus series. Standard `process_*` / `nodejs_*` series
are wired against the same private registry so they surface alongside.

Cardinality cap: `METRICS_MAX_SERIES_PER_METRIC` (default 10000) bounds the
distinct label tuples any single metric may track. New tuples past the cap
are dropped silently and a one-shot warning is logged per metric. Set to 0
to disable. Tune up before tuning off.

## UI modules (customer portal + operator admin)

The bridge ships two browser apps from `bridge-ui/`:

- `bridge-ui/portal/` → mounted at `/portal/*` (customer self-service: balance, API keys, top-up, usage, settings).
- `bridge-ui/admin/` → mounted at `/admin/console/*` (operator: health, nodes, customers, refund/suspend/issue-key, audit, reservations, top-ups, nodes.yaml view).

Both are static SPAs served by `@fastify/static` from inside the same Fastify instance that hosts `/v1/*` and `/admin/*` JSON. `existsSync(<dist>)` guards each registration — if a UI's `dist/` is missing the bridge logs a warn and skips the mount; HTTP routes still serve.

### Build

The top-level `npm run build` chains:

1. `tsc -p tsconfig.json` (server)
2. `cd bridge-ui && npm ci && npm run build:all` (workspace `npm ci` hoists `lit` + `rxjs` into `bridge-ui/node_modules`; `build:all` runs Vite for portal then admin)

Output: `dist/` (server) + `bridge-ui/portal/dist/` + `bridge-ui/admin/dist/`.

### Docker

The `Dockerfile` has a dedicated `ui` build stage that runs the workspace `npm ci` + `build:all` once, then the runtime stage copies both `dist/` outputs:

```dockerfile
COPY --from=ui /ui/portal/dist ./bridge-ui/portal/dist
COPY --from=ui /ui/admin/dist ./bridge-ui/admin/dist
```

devDeps (`vite`, `@web/test-runner`, `@open-wc/testing`, `playwright`, etc.) stay in the build stage and never reach the runtime image.

### Local development

Two Vite dev servers proxy to the bridge:

```bash
# In one shell — start the bridge
docker compose up

# In a second shell — portal dev server (default :5173)
npm run dev:ui:portal      # → http://localhost:5173/portal/

# In a third shell — admin dev server (default :5174)
npm run dev:ui:admin       # → http://localhost:5174/admin/console/
```

`vite.config.js` for each module proxies its API path prefix to `BRIDGE_DEV_TARGET` (default `http://localhost:8080`).

### Operator admin — Grafana link

The Health page renders a styled "Open Grafana dashboard ↗" link when `window.GRAFANA_DASHBOARD_URL` is set on the served `index.html` (via a build-time env, a small bootstrap script, or a reverse-proxy injection); otherwise the panel collapses to a "configure to enable" hint. The link opens in a new tab — operators stay on the console for audit / customer / node investigations and pop out to Grafana for metrics drill-down.

This deliberately does **not** embed Grafana via `<iframe>`. Embedding would force one of three setup costs (anonymous read-only role on the dashboard, a shared auth proxy across both surfaces, or signed-iframe URLs from a bridge backend route) plus `allow_embedding = true` on Grafana's side. None of those are necessary for the workflow — a link gives the same single-tab feel for nine investigations out of ten and zero infrastructure cost. If embedding ever becomes load-bearing, this section + `bridge-ui/admin/components/admin-health.js` are the two places to revisit.

`window.GRAFANA_DASHBOARD_URL` accepts any URL the operator's browser can reach. Common shape — inject via build-time env or `index.html` template:

```html
<script>window.GRAFANA_DASHBOARD_URL = 'https://grafana.internal/d/livepeer-bridge';</script>
```

### Operator handle (`X-Admin-Actor`)

The admin sign-in form captures a free-text operator handle (matching `^[a-z0-9._-]{1,64}$`) and attaches it as `X-Admin-Actor` on every admin request. The bridge writes that handle into `admin_audit_event.actor` so the audit log shows `alice` / `bob` instead of an opaque token-hash. Missing or malformed handles fall back to the token-hash (unchanged from pre-0023 behavior).

This is **attribution, not authentication**. There is still one shared `ADMIN_TOKEN`. Per-operator tokens + RBAC are Phase 2.

## What's not yet automated

- **CI image publishing.** No workflow builds and pushes the bridge image on merge; you ship your own tag. Tracked in `docs/exec-plans/tech-debt-tracker.md` as "CI workflow to build + push bridge image."
- **End-to-end live smoke.** No repo-side tests exercise the full stack against a live Arbitrum endpoint. Integration tests cover each component (Testcontainers Postgres + Redis, fake gRPC daemon for the payer client). A full live smoke is tracked as "Real daemon smoke test" tech-debt.
- **TLS termination.** Assumed to be handled by an external reverse proxy (nginx, Traefik, a cloud load balancer). The bridge speaks plain HTTP on port 8080.
- **Secrets injection.** `.env` is the sole secret source today. See the "API key pepper lives in plain env" tech-debt entry for the secret-manager migration path.

## Related

- Library-side daemon docs (sibling repo): `livepeer-payment-library/docs/operations/running-with-docker.md`.
- [Architecture](../design-docs/architecture.md)
- [PayerDaemon integration](../design-docs/payer-integration.md)
- [Tech-debt tracker](../exec-plans/tech-debt-tracker.md)
