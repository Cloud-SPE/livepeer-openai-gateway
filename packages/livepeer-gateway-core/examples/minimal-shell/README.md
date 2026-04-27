# minimal-shell

The smallest runnable wiring of `@cloudspe/livepeer-gateway-core`.
Boots a Fastify server on `:8080`, accepts
`POST /v1/chat/completions`, dispatches to the worker pool, and
returns OpenAI-shaped responses.

**Use this to verify your worker pool + the two daemons are
reachable** before wiring real adapters in your own shell.

## What's bundled

- **Fastify** — the HTTP entry point.
- **`InMemoryWallet`** — records reservations in memory; does NOT
  enforce balances or quotas. Every reserve() succeeds.
- **No-op AuthResolver** — any `Bearer` token resolves to a single
  `id: 'anonymous'` caller. Don't run this on the public internet.
- **Engine defaults** — Postgres-backed `engine.usage_records`,
  Redis-backed rate limiter, tiktoken-based token audit, real
  payment-daemon and service-registry-daemon gRPC clients.

## Prerequisites

- Docker + docker-compose (the bundled `compose.yaml` brings up all
  five services).
- An Arbitrum One RPC URL (set via `CHAIN_RPC` env var) for the
  payer-daemon.
- An Ethereum keystore + password matching the bridge identity (the
  daemon signs tickets with this key).
- A worker pool to point the registry-daemon at — at least one
  WorkerNode advertising at least one capability.

## Setup

```sh
cd examples/minimal-shell

# 1. Worker pool config — edit to point at your worker(s).
cp service-registry-config.example.yaml service-registry-config.yaml
$EDITOR service-registry-config.yaml

# 2. Payer-daemon keystore. The compose.yaml expects these two
#    files in this directory; mount paths are configurable but
#    the defaults are the simplest.
cp /path/to/your/keystore.json keystore.json
printf '%s' 'your-keystore-password' > keystore-password
chmod 600 keystore.json keystore-password

# 3. Set required env vars in your shell or in a `.env` file.
export CHAIN_RPC='https://arb1.arbitrum.io/rpc'
export BRIDGE_ETH_ADDRESS='0x...'   # must match keystore.json's address

# 4. Bring up the stack.
docker compose up
```

The first boot pulls Postgres, Redis, the two daemon images, and
Node 20. After that it's ~5 seconds to a healthy gateway.

## Smoke test

In another shell:

```sh
curl -sS http://localhost:8080/healthz
# {"status":"ok"}

curl -sS http://localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer demo' \
  -H 'content-type: application/json' \
  -d '{
    "model": "llama-3.3-70b",
    "messages": [{"role": "user", "content": "hi"}]
  }' | jq .
```

If you get an OpenAI-shaped response with `choices[0].message`, the
full path works: auth → rate-limit → reserve → select node → call
worker → commit. If you get `503 model_unavailable`, your registry
config doesn't list any node advertising `llama-3.3-70b` for the
`free` tier — edit `service-registry-config.yaml`.

## What this example doesn't show

- **Real billing** — `InMemoryWallet` accepts every request. See
  `examples/wallets/` for postpaid / prepaid-USD / free-quota
  patterns.
- **Real auth** — the no-op `AuthResolver` accepts any token. Wire
  a real bearer-token / mTLS / API-key resolver in your own shell.
- **Streaming chat** — the example only registers
  `/v1/chat/completions` (non-streaming). Streaming is at
  `@cloudspe/livepeer-gateway-core/runtime/http/chat/streaming.js`
  and follows the same wiring pattern.
- **Embeddings, images, audio** — same deal, register the routes
  from `@cloudspe/livepeer-gateway-core/runtime/http/{embeddings,
  images, audio}/` if you need them.
- **Metrics** — the example uses `NoopRecorder`. For production
  metrics, swap in `PrometheusRecorder` and register
  `createMetricsServer` on a separate port.
- **Operator dashboard** — register
  `@cloudspe/livepeer-gateway-core/dashboard` if you want the
  read-only `/admin/ops` view; wire `createBasicAdminAuthResolver`
  for token auth.

## Cleanup

```sh
docker compose down -v   # also drops the postgres volume
```

## See also

- The reference shell at
  [`Cloud-SPE/livepeer-openai-gateway`](https://github.com/Cloud-SPE/livepeer-openai-gateway)
  shows what a production-ready wiring looks like — Postgres-backed
  prepaid USD wallet, API-key auth from a real customer table,
  Stripe top-up integration, admin SPA, customer portal.
- [`docs/architecture.md`](../../docs/architecture.md) — engine
  internals.
- [`docs/adapters.md`](../../docs/adapters.md) — what the five
  operator-overridable adapters look like.
