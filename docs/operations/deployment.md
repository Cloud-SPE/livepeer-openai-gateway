---
title: Deployment — full-stack docker compose
status: accepted
last-reviewed: 2026-04-24
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
