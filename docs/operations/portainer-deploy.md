---
title: Portainer production deployment walkthrough
status: accepted
last-reviewed: 2026-04-30
---

# Portainer production deployment walkthrough

Step-by-step deploy of the bridge stack on a Portainer-managed host. Reflects the
currently published shell/runtime combination
(`@cloudspe/livepeer-openai-gateway-core@3.0.0`,
`tztcloud/livepeer-payment-daemon:v3.0.2`,
`tztcloud/livepeer-service-registry-daemon:v3.0.2`,
bridge image `tztcloud/livepeer-openai-gateway:3.0.1`).

> **Runtime note:** the shell image described here is on the v3
> route-first payment flow: resolver `Select(...)`, bridge-computed
> `face_value`, payment-daemon `CreatePayment(...)`, and direct worker
> `/v1/*` requests. Worker `/quote`, `/quotes`, and `/capabilities` are
> not part of this deploy.

The full feature surface — admin SPA, customer portal, operator-managed rate card, customer onboarding, registry-driven node pool, Stripe billing, Prometheus metrics — is in this image. Everything operators need is reachable from `/admin/console/`.

> **Not on Portainer?** See [`deployment.md`](./deployment.md) for the docker-compose CLI flow. Same containers, same env, just different driver.

## Prerequisites (operator side, off-host)

Before touching Portainer, gather:

| Required                                   | Description                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Arbitrum One RPC URL**                   | Any provider — Alchemy, Infura, your own node. Set as `CHAIN_RPC`. The bridge passes it through to the payment-daemon and the service-registry-daemon.                                                                                                           |
| **Resolver registry contract**             | Set as `SERVICE_REGISTRY_CONTRACT_ADDRESS`. This gateway defaults to the Arbitrum One **AI service registry** (`0x04C0b249740175999E5BF5c9ac1dA92431EF34C5`). One resolver deployment targets exactly one registry contract.                                     |
| **Ethereum keystore (V3 JSON) + password** | The signing wallet used by the payment-daemon sender sidecar. Generated via `geth account new` if you don't have one.                                                                                                                                            |
| **Stripe secret + webhook signing keys**   | `sk_live_...` (or `sk_test_...` for staging). Webhook secret from your Stripe Dashboard → Developers → Webhooks → endpoint signing secret.                                                                                                                       |
| **Public hostname for the bridge**         | Set as `BRIDGE_PUBLIC_HOST`. Traefik or your reverse proxy routes `Host(${BRIDGE_PUBLIC_HOST})` → the bridge container.                                                                                                                                          |
| **Service-registry overlay YAML**          | One file describing the worker pool the bridge should route to. Format below.                                                                                                                                                                                    |
| **Random-but-stable secrets**              | `ADMIN_TOKEN` (≥ 32 chars), `API_KEY_PEPPER` (≥ 16 chars), `PGPASSWORD`. Generate once with `openssl rand -base64 32`; rotating these is non-trivial (`API_KEY_PEPPER` invalidates every customer key in the table; `PGPASSWORD` requires DB password rotation). |

## Step 1 — Place the registry overlay on the host

The service-registry-daemon reads its node pool from a YAML file you provide. The bridge consumes the daemon's `ListKnown` over a unix socket; you don't edit anything on the bridge side to add/remove a worker.

```bash
# On the prod host (NOT inside any container).
sudo mkdir -p /opt/livepeer-openai-gateway
sudo $EDITOR /opt/livepeer-openai-gateway/service-registry-config.yaml
sudo chmod 644 /opt/livepeer-openai-gateway/service-registry-config.yaml
```

File format (one entry per orchestrator eth_address; pin nodes are the actual workers):

```yaml
overlay:
  - eth_address: '0xd003...' # orchestrator's payment recipient
    enabled: true
    tier_allowed: [free, prepaid]
    weight: 100
    unsigned_allowed: true # required when no on-chain manifest exists
    pin:
      - id: worker-1
        url: 'https://worker-1.example.com'
        weight: 100
        capabilities:
          - name: 'openai:/v1/chat/completions'
            work_unit: token
            offerings:
              - id: 'Qwen3-32B'
                price_per_work_unit_wei: '25000000'
                warm: true
        tier_allowed: [free, prepaid]
```

**Authoritative reference:** `livepeer-modules/service-registry-daemon/registry.example.yaml` and `examples/static-overlay-only/nodes.yaml`. The required nested list is `offerings[]`; `models[]` is no longer a valid overlay field.

## Step 2 — Create the Portainer stack

Portainer → **Stacks** → **+ Add stack** → Web editor. Paste the following, swapping ALL `${...}` env vars in the editor's "Environment variables" section below:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: openai-gateway-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${PGUSER:-bridge}
      POSTGRES_PASSWORD: ${PGPASSWORD:?set PGPASSWORD}
      POSTGRES_DB: ${PGDATABASE:-bridge}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', '${PGUSER:-bridge}', '-d', '${PGDATABASE:-bridge}']
      interval: 5s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    container_name: openai-gateway-redis
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 20

  payment-daemon:
    image: tztcloud/livepeer-payment-daemon:v3.0.2
    restart: unless-stopped
    command:
      - --mode=sender
      - --socket=/var/run/livepeer/payment.sock
      - --store-path=/var/lib/livepeer/payment.db
      - --chain-rpc=${CHAIN_RPC:?set CHAIN_RPC}
      - --keystore-path=/etc/livepeer/keystore.json
      - --keystore-password-file=/etc/livepeer/keystore-password
      - --log-level=${DAEMON_LOG_LEVEL:-info}
    volumes:
      - ${PAYER_KEYSTORE_PATH:-/opt/livepeer-openai-gateway/keystore.json}:/etc/livepeer/keystore.json:ro
      - ${PAYER_KEYSTORE_PASSWORD_PATH:-/opt/livepeer-openai-gateway/keystore-password}:/etc/livepeer/keystore-password:ro
      - socket-dir:/var/run/livepeer
      - payment-state:/var/lib/livepeer
    read_only: true
    security_opt:
      - no-new-privileges:true

  service-registry-daemon:
    image: tztcloud/livepeer-service-registry-daemon:v3.0.2
    restart: unless-stopped
    command:
      - --mode=resolver
      - --discovery=overlay-only
      - --socket=/var/run/livepeer/service-registry.sock
      - --static-overlay=/etc/livepeer/service-registry.yaml
      - --service-registry-address=${SERVICE_REGISTRY_CONTRACT_ADDRESS:-0x04C0b249740175999E5BF5c9ac1dA92431EF34C5}
      - --store-path=/var/lib/livepeer/registry-cache.db
      - --chain-rpc=${CHAIN_RPC}
      - --log-level=${DAEMON_LOG_LEVEL:-info}
      - --log-format=json
    volumes:
      - ${SERVICE_REGISTRY_CONFIG_PATH:-/opt/livepeer-openai-gateway/service-registry-config.yaml}:/etc/livepeer/service-registry.yaml:ro
      - socket-dir:/var/run/livepeer
      - service-registry-state:/var/lib/livepeer
    read_only: true
    security_opt:
      - no-new-privileges:true

  bridge-migrate:
    image: tztcloud/livepeer-openai-gateway:3.0.1
    restart: 'no'
    command: ['packages/livepeer-openai-gateway/dist/scripts/migrate.js']
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      PGHOST: postgres
      PGPORT: '5432'
      PGUSER: ${PGUSER:-bridge}
      PGPASSWORD: ${PGPASSWORD:?set PGPASSWORD}
      PGDATABASE: ${PGDATABASE:-bridge}

  bridge:
    image: tztcloud/livepeer-openai-gateway:3.0.1
    container_name: openai-bridge-gateway
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      payment-daemon: { condition: service_started }
      service-registry-daemon: { condition: service_started }
      bridge-migrate: { condition: service_completed_successfully }
    environment:
      HOST: '0.0.0.0'
      PORT: '8080'
      PGHOST: postgres
      PGPORT: '5432'
      PGUSER: ${PGUSER:-bridge}
      PGPASSWORD: ${PGPASSWORD:?set PGPASSWORD}
      PGDATABASE: ${PGDATABASE:-bridge}
      REDIS_HOST: redis
      REDIS_PORT: '6379'
      API_KEY_PEPPER: ${API_KEY_PEPPER:?set API_KEY_PEPPER (≥ 16 chars)}
      API_KEY_ENV_PREFIX: ${API_KEY_ENV_PREFIX:-test}
      PAYER_DAEMON_SOCKET: /var/run/livepeer/payment.sock
      SERVICE_REGISTRY_SOCKET: /var/run/livepeer/service-registry.sock
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY:?set STRIPE_SECRET_KEY}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET:?set STRIPE_WEBHOOK_SECRET}
      STRIPE_SUCCESS_URL: https://${BRIDGE_PUBLIC_HOST}/portal/billing/success
      STRIPE_CANCEL_URL: https://${BRIDGE_PUBLIC_HOST}/portal/billing/cancel
      ADMIN_TOKEN: ${ADMIN_TOKEN:?set ADMIN_TOKEN (≥ 32 chars)}
      BRIDGE_AUTO_MIGRATE: 'false'
    volumes:
      - socket-dir:/var/run/livepeer
    healthcheck:
      test:
        [
          'CMD',
          '/nodejs/bin/node',
          '-e',
          "require('http').get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))",
        ]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
  socket-dir:
  payment-state:
  service-registry-state:

networks:
  default:
    name: ingress
    external: true
```

In the **Environment variables** panel below the editor, set every `${...}` value: `CHAIN_RPC`, `SERVICE_REGISTRY_CONTRACT_ADDRESS`, `BRIDGE_PUBLIC_HOST`, `PGPASSWORD`, `API_KEY_PEPPER`, `ADMIN_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Optional defaults work for `PGUSER` (`bridge`), `PGDATABASE` (`bridge`), `API_KEY_ENV_PREFIX` (`test`).

For AI gateway deployments, `SERVICE_REGISTRY_CONTRACT_ADDRESS` should be the Arbitrum One AI service registry:

```text
0x04C0b249740175999E5BF5c9ac1dA92431EF34C5
```

Click **Deploy the stack**. First run pulls all five images (~2-3 min), runs `bridge-migrate` to apply schemas (engine + app + rate-card + seed defaults), then starts the bridge.

## Step 3 — Verify the stack is healthy

In Portainer **Containers**, all 5 services should be `running` and healthchecks `healthy`. From your shell:

```bash
export ADMIN_TOKEN='...'                            # the value from the stack
export H='your.public.host'                         # whatever you set BRIDGE_PUBLIC_HOST to

# Liveness — no auth needed
curl -sS https://$H/healthz                         # → {"ok":true}

# Composed health — admin auth
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://$H/admin/health | jq .
# expect: ok=true, payerDaemonHealthy=true, dbOk=true, redisOk=true,
#         serviceRegistryHealthy=true, nodeCount > 0

# Live registry probe — bypasses bridge cache, hits the daemon directly
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://$H/admin/registry/probe | jq .
# expect: liveCount > 0, live[0] is your worker
```

If `nodeCount` is `0` or `liveCount` is `0`, see the **Triage** section below.

## Step 4 — Bootstrap the first customer + API key

The admin SPA's "+ New customer" button (added in [exec-plan 0029](../exec-plans/completed/0029-admin-customer-onboarding.md)) is the canonical way to seed customers. No more SQL gymnastics.

1. Open `https://$BRIDGE_PUBLIC_HOST/admin/console/`
2. Sign in with `ADMIN_TOKEN` + any handle (e.g. `alice`)
3. Click **Customers** → **+ New customer**
4. Fill in email, tier (`free` or `prepaid`), optional balance/quota, submit
5. The form lands on the new customer's detail page; click **Issue API key** → copy the plaintext key shown once

Send a test request:

```bash
curl -sS https://$H/v1/chat/completions \
  -H "Authorization: Bearer <the-key-from-step-5>" \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen3-32B","messages":[{"role":"user","content":"hi"}]}'
```

If you get `model_not_found`, your worker advertises a model the rate card doesn't know about — see Step 5.

## Step 5 — Add the worker's model to the rate card

The rate card (added in [exec-plan 0030](../exec-plans/completed/0030-operator-managed-rate-card.md)) decides what to charge customers per model. Earlier engine releases had hardcoded entries; the current shell reads operator-managed DB tables seeded with defaults.

`bridge-migrate` already populated the seed: starter/standard/pro/premium tiers + the engine's pre-existing models (`gemma4:26b`, `text-embedding-3-*`, `dall-e-3`, etc.). To add your own model:

1. Admin SPA → **Rate card** → **Chat**
2. Click **+ Add model / pattern**
3. Type → **Exact model name**, fill in your worker's model id (e.g. `Qwen3-32B`), pick a tier (`standard` is the conservative middle-tier default)
4. Submit. The rate-card service invalidates its cache; the next chat request to that model resolves immediately.

For workers advertising many models, use **Glob pattern** instead — `Qwen3.*` matches every Qwen3 variant your worker brings up later.

The same pattern works for the other capabilities — Embeddings, Images (composite key: model + size + quality), Speech, Transcriptions — each on its own sub-tab.

## Step 6 — End-to-end smoke

```bash
# Verify the rate-card surface from outside
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://$H/admin/pricing/chat/tiers | jq .
# expect 4 tiers with seeded prices

curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://$H/admin/pricing/chat/models | jq '.entries | length'
# expect 5+ (the seeded V1 models + whatever you added)

# A real chat completion should now succeed:
curl -sS https://$H/v1/chat/completions \
  -H "Authorization: Bearer <customer-api-key>" \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen3-32B","messages":[{"role":"user","content":"tell me a one-line story"}]}'
# expect 200 with OpenAI-shaped { id, choices, usage }

# Customer's balance should show the actual cost in the portal
# (https://$H/portal/, paste the customer's API key)
```

## Triage — `nodeCount: 0` after a healthy boot

In order, fastest first:

```bash
# 1. Bridge enumeration log line
docker logs openai-bridge-gateway 2>&1 | grep -E 'registry:'
# expect: "registry: enumerated N known nodes"

# 2. Daemon's view of the overlay
docker logs $(docker ps --format '{{.Names}}' | grep service-registry-daemon) \
  --tail 30 | grep -iE 'overlay|loaded'

# 3. Live probe — does the daemon think the address is reachable?
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://$H/admin/registry/probe | jq .
# liveCount > 0 + cachedCount = 0 → just restart the bridge container
# liveCount = 0                  → daemon's overlay is empty or unreadable
# error.message in response      → daemon socket isn't reachable
```

**Common root causes:**

| Symptom                                  | Cause                                                                                                                                                     | Fix                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Daemon says `0 nodes loaded`             | Overlay file path on host doesn't match `SERVICE_REGISTRY_CONFIG_PATH` env, or the file is empty                                                          | `ls -la /opt/livepeer-openai-gateway/`; verify the env var matches              |
| Pin nodes don't surface                  | `unsigned_allowed: false` in overlay (chainless mode requires `true`)                                                                                     | Edit overlay → `unsigned_allowed: true` → recreate daemon                       |
| `chain.GetServiceURI` returns `NotFound` | Address not on Arbitrum BondingManager AND `unsigned_allowed: false`. Daemon `v1.3.0` synth path requires `unsigned_allowed: true` to surface pin entries | As above                                                                        |
| `payerDaemonHealthy: false`              | Keystore path/password wrong, or `CHAIN_RPC` unreachable                                                                                                  | `docker logs` the payment-daemon container                                      |
| `dbOk: false`                            | `PGPASSWORD` mismatch (likely after rotation without volume recreate)                                                                                     | Recreate the postgres volume (dev only) or rotate the DB's password through SQL |

## Routine operations

| Task                            | How                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a worker                    | Edit `/opt/livepeer-openai-gateway/service-registry-config.yaml`; recreate the `service-registry-daemon` container in Portainer; restart the bridge container so it re-enumerates |
| Add a model                     | Admin SPA → Rate card → Chat (or other capability) → + Add. No restart.                                                                                                           |
| Change tier prices              | Admin SPA → Rate card → Chat → click Edit on the tier row. No restart.                                                                                                            |
| Refund a customer               | Admin SPA → Customers → click customer → Refund. Requires the Stripe session id.                                                                                                  |
| Suspend / unsuspend             | Admin SPA → Customers → click customer → Suspend (writes audit row, halts API access)                                                                                             |
| Investigate a stuck reservation | Admin SPA → Reservations (oldest-first list, age in seconds). The fix is upstream — node health, payer-daemon. There's no "force close" button by design.                         |
| Rotate `ADMIN_TOKEN`            | Update env in Portainer stack → Update the stack. All open admin sessions are invalidated.                                                                                        |
| Rotate `API_KEY_PEPPER`         | **Destructive.** Invalidates every `api_key.hash` row. Coordinate with customers; reissue all keys after rotation. Tracked as `api-key-pepper-rotation-runbook` in tech-debt.     |
| Bump the bridge image           | Update `tztcloud/livepeer-openai-gateway:3.0.1` to a newer tag in the stack editor → Update the stack with **Re-pull image** ticked. Bridge migrations run automatically.         |

## Image upgrade — what to expect

The bridge image now ships on semver tags (`3.0.1`, `3.0`) plus `latest`. To pull the exact `3.0.1` digest:

1. Portainer → Stacks → click your stack → **Editor** tab
2. Scroll to the bottom → **Update the stack**
3. Tick **Re-pull image and redeploy**
4. Click **Update the stack**

`bridge-migrate` runs first (idempotent — only applies migrations not in `public.bridge_schema_migrations`), then the bridge restarts. ~30 second downtime per replica.

## What's NOT covered here (cross-references)

- **Stripe webhook setup** — `livepeer-modules/payment-daemon/docs/operations/running-with-docker.md` and Stripe's Dashboard.
- **Reverse proxy / TLS** — assumes you already run Traefik (or similar) on the host. The bridge speaks plain HTTP on `:8080`; the proxy terminates TLS.
- **Prometheus scraping** — see `deployment.md` § Observability.
- **Customer portal usage** — see `docs/product-specs/customer-portal.md` for the customer-side flows.

## Post-deploy verification checklist

- [ ] All 5 stack containers show `healthy` in Portainer
- [ ] `GET /healthz` returns 200
- [ ] `GET /admin/health` shows all `*Healthy: true` and `nodeCount > 0`
- [ ] `GET /admin/registry/probe` shows `liveCount > 0`
- [ ] Admin SPA loads at `https://${BRIDGE_PUBLIC_HOST}/admin/console/`
- [ ] Rate card seeded — `GET /admin/pricing/chat/tiers` returns 4 tiers
- [ ] First customer created via SPA + API key issued
- [ ] Real `/v1/chat/completions` request returns 200 with usage
- [ ] Customer balance decremented in the portal

If all 9 checks pass, the deployment is functionally complete.

## Related

- [`deployment.md`](./deployment.md) — full reference (docker-compose CLI flow, dev/smoke profiles, manual API-key issuance fallback, troubleshooting)
- [`docs/product-specs/admin-endpoints.md`](../product-specs/admin-endpoints.md) — admin API reference
- [`docs/exec-plans/completed/0030-operator-managed-rate-card.md`](../exec-plans/completed/0030-operator-managed-rate-card.md) — rate-card design + scope
- [`docs/exec-plans/tech-debt-tracker.md`](../exec-plans/tech-debt-tracker.md) — open backlog items
