---
title: Deployment — full-stack docker compose
status: accepted
last-reviewed: 2026-04-25
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

## Prod walkthrough

Additional prerequisites:

- A tagged, pushed bridge image (the compose override does not build). Until CI publishing lands:
  ```bash
  docker build -t tztcloud/livepeer-openai-gateway:v0.8.10 .
  docker push tztcloud/livepeer-openai-gateway:v0.8.10
  ```
- Set `BRIDGE_IMAGE` in `.env` to that tag.
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
