---
title: Node lifecycle (registry-daemon, QuoteRefresher, health + circuit breaker)
status: accepted
last-reviewed: 2026-04-28
---

# Node lifecycle

How WorkerNodes enter, run in, and leave the bridge's routing pool.

## Status — post-engine-extraction

> **2026-04-28:** the bridge no longer reads a local `nodes.yaml`. The
> service-registry-daemon (sibling project at
> `livepeer-modules/service-registry-daemon`) owns node config
> via its `--static-overlay=...` YAML and exposes them through gRPC
> `Resolver.ListKnown` / `Select` over a unix socket. The bridge's
> `serviceRegistry` provider is the gRPC client; it enumerates once at
> startup into a start-time-static `nodeIndex`. To change the worker
> pool, edit the daemon's overlay file and recreate the daemon
> container — the bridge picks up the new pool on next restart.
>
> Live triage of "what does the daemon currently have?" is via
> `GET /admin/registry/probe` (live `listKnown` bypassing the bridge's
> cache) and `serviceRegistryHealthy` on `/admin/health`. See
> [`product-specs/admin-endpoints.md`](../product-specs/admin-endpoints.md).
>
> The daemon's overlay schema (operator-curated `nodes.yaml`) is
> documented in the daemon repo at `examples/static-overlay-only/` and
> `registry.example.yaml`. Pre-extraction this doc described the
> bridge-side config; that section is preserved below for historical
> context but does not reflect today's routing.

## (Historical) Source of truth: `nodes.yaml`

Config-driven allowlist. The file path is passed to the bridge process; SIGHUP triggers a safe reload. Shape (Appendix B of `docs/references/openai-bridge-architecture.md`, extended with per-node knobs):

```yaml
nodes:
  - id: node-a # stable logical id; also the node_health PK
    url: https://node-a.example.com # base URL for /health, /capabilities, /quote, /quotes
    ethAddress: '0xabcd...' # Ethereum address the node receives tickets at
    supportedModels: ['gpt-4o-mini', 'text-embedding-3-small']
    capabilities: ['chat', 'embeddings'] # 0017+; defaults to ['chat'] if omitted
    enabled: true
    tierAllowed: ['free', 'prepaid']
    weight: 100 # used by router for weighted selection (0007)

    # Optional per-node overrides (defaults shown):
    quoteRefreshSeconds: 30
    healthTimeoutMs: 5000
    quoteTimeoutMs: 10000
    failureThreshold: 5
    coolDownSeconds: 30
```

Validation happens through Zod (`NodeConfigSchema` + the per-node knob extensions). Any parse error rejects the whole reload — partial state is never applied.

Bridge-level config (separate from `nodes.yaml`):

- `BRIDGE_ETH_ADDRESS` — the bridge's sender address as configured in the local payer-daemon's keystore. Used as the `?sender=` query param on `/quote` and `/quotes` calls so the worker can return ticket params bound to this payer. See exec-plan 0018.

## Worker HTTP contract (post-0018)

The bridge probes four worker endpoints. All emit snake_case JSON; byte-typed fields use `0x`-prefixed hex strings so `BigInt('0x…')` is the canonical decoder. Wei fields use decimal strings.

The full per-endpoint contract is the source of truth in `docs/references/worker-node-contract.md`; the schemas below summarise what the bridge actually validates.

### `/health`

```
GET /health
```

```json
{
  "status": "ok" | "degraded",
  "protocol_version": 1,
  "max_concurrent": 8,
  "inflight": 2,
  "detail": "optional"
}
```

- `ok` — node is ready to serve inference. Router may route.
- `degraded` — node is reachable but self-reports reduced capacity. Router still considers it healthy for admission; operators should monitor the `degraded` count. A dedicated degraded→broken escalation policy is future work.
- Anything else (non-2xx, body fails the schema, timeout) — treated as a failure; counts against the circuit breaker.

### `/capabilities`

```
GET /capabilities
```

```json
{
  "protocol_version": 1,
  "capabilities": [
    {
      "capability": "openai:/v1/chat/completions",
      "work_unit": "token",
      "models": [{ "model": "gpt-4o-mini", "price_per_work_unit_wei": "1000" }]
    }
  ]
}
```

Discovery surface. Pre-0020 the bridge consumed this only at config-validation time; post-0020 the refresher cross-checks declared `capabilities` in `nodes.yaml` against what the worker actually advertises and logs a warn on mismatch.

### `/quote?sender=&capability=`

```
GET /quote?sender=0x...&capability=openai:/v1/chat/completions
```

```json
{
  "ticket_params": {
    "recipient": "0x...",
    "face_value_wei": "0x3b9aca00",
    "win_prob": "0x...",
    "recipient_rand_hash": "0x...",
    "seed": "0x...",
    "expiration_block": "0x3e8",
    "expiration_params": {
      "creation_round": 12345,
      "creation_round_block_hash": "0x..."
    }
  },
  "model_prices": [{ "model": "gpt-4o-mini", "price_per_work_unit_wei": "1000" }]
}
```

Validated by `NodeQuoteResponseSchema` in `src/providers/nodeClient.ts`. The wire shape is projected to the domain-level `Quote` type from `src/types/node.ts`, which carries `ticketParams` plus a `modelPrices: Map<string, bigint>` keyed by model name.

### `/quotes?sender=`

```
GET /quotes?sender=0x...
```

```json
{
  "quotes": [
    { "capability": "openai:/v1/chat/completions", "quote": { ... } },
    { "capability": "openai:/v1/embeddings",       "quote": { ... } }
  ]
}
```

Batched form used by `quoteRefresher` since 0018: one round-trip pulls every capability the worker is configured to serve. The refresher splits the response and calls `NodeBook.setAllQuotes(nodeId, perCapability)`.

Health probes run on the same cadence as quote refresh (one `/health` and one `/quotes` per node per `quoteRefreshSeconds`), with separate timeouts for each endpoint.

## In-memory storage: `NodeEntry.quotes`

Since 0020, each `NodeEntry` carries `quotes: Map<string, Quote>` keyed by capability string (`openai:/v1/chat/completions`, `openai:/v1/embeddings`, …). A node that advertises N capabilities ends up with N entries in this map after each successful refresh; routing for capability C requires `node.quotes.has(capabilityString(C))`.

Per-model pricing lives one level down inside `Quote.modelPrices` so the (capability-shared) ticket params are not duplicated across models. The single source of truth for the `chat` ↔ `openai:/v1/chat/completions` mapping is `capabilityString(cap: NodeCapability)` in `src/types/capability.ts`.

## Refresh cadence

Default 30 s, configurable per-node via `quoteRefreshSeconds`. Rationale: ticket expiration is ~1 round (~5.5 min on mainnet), so refreshing every 30 s gives ~10 refreshes per expiration window. At 3–5 nodes, total polling load is <0.2 rps.

## Circuit breaker

Pure state machine (`src/service/nodes/circuitBreaker.ts`). No internal timers — `now: Date` is injected so tests run deterministically.

```
                 failure (< threshold)
               ┌───────────────┐
               │               │
       ┌───────▼────────┐      │
       │                ├──────┘
       │    healthy     │
       │   (or degraded,│         failureThreshold consecutive
       │    same for    │────────────────────► failures
       │    routing)    │                    │
       └─────▲──────────┘                    │
             │                               ▼
 probe ok    │                     ┌──────────────────┐
             │                     │                  │
    ┌────────┴─────────┐           │ circuit_broken   │
    │  half_open       │◄──────────┤                  │
    │ (probe in flight)│           └─────────┬────────┘
    └────────┬─────────┘                     │
             │                               │
             │ probe fails                   │ cool-down
             └───────────────────────────────┘   elapsed
```

- `failureThreshold` consecutive failures → `circuit_broken`. Logged as `circuit_opened` event.
- During cool-down (`coolDownSeconds`), no probes fire. Router skips the node.
- After cool-down, exactly one probe is scheduled. Logged as `circuit_half_opened`.
- Success on that probe → `circuit_closed`; normal polling resumes.
- Failure → re-open with a fresh cool-down.

Defaults: `failureThreshold=5`, `coolDownSeconds=30`. Both overridable per node.

## Persistence

Two tables in Postgres (Drizzle schema, migration 0002):

- **`node_health`** — one row per node, current snapshot. Upserted on every probe tick. Key columns: `status`, `consecutive_failures`, `last_success_at`, `last_failure_at`, `circuit_opened_at`, `updated_at`. This is what survives restart — circuit state (`circuit_opened_at` + `consecutive_failures`) is rehydrated into `CircuitState` at bridge startup.
- **`node_health_event`** — append-only log of state transitions only (NOT every probe). Event kinds: `circuit_opened`, `circuit_half_opened`, `circuit_closed`, `config_reloaded`, `eth_address_changed_rejected`. Indexed by `(node_id, occurred_at)`. v1 retains events indefinitely — low volume (one event per incident); retention sweeps tracked in tech-debt.

Deliberately **not** logged: individual probe successes or failures that don't change circuit state. Keeps the event stream signal-dense.

## Reload semantics

`SIGHUP` → re-read YAML → validate → diff against current in-memory config:

- **Happy path** — `NodeBook.replaceAll(next, prevSnapshot)` preserves existing `CircuitState` for any `node_id` present in both configs. A `config_reloaded` event is logged per node. Quote cache is cleared (the refresher re-fetches on the next tick).
- **`eth_address` mutation detected** — reload is rejected with `EthAddressChangedError`. A `eth_address_changed_rejected` event is logged per affected node. Running state is untouched. Rationale: pending payments on PayerDaemon point at the old address; silently accepting the mutation would strand them. Operators must deliberately renumber the node (`new_id`) to start a fresh payment session — that drains the old sessions cleanly.
- **Validation failure** — reload is rejected; no partial state is applied.

## Routing

```
NodeBook.findNodesFor(model, tier, capability): NodeEntry[]
```

Filters nodes by `enabled`, supported model, allowed tier, declared capability, **presence of a quote for that capability** (post-0020), and circuit status (`circuit_broken` excluded). Sorts by `weight` descending. Router (`src/service/routing/`) is responsible for the actual selection policy (currently weighted-random with per-attempt failover); NodeBook just returns the admission set.

`NoHealthyNodesError` thrown when nothing matches (mapped to customer-facing `model_unavailable`).

## Out of scope (logged in tech-debt)

- Open node discovery via Livepeer subgraph / on-chain registry.
- Event retention sweeps (at current volume, not needed).
- Degraded→broken escalation policy (v1 treats `degraded` as routable).
- File-watch auto-reload (v1 relies on explicit SIGHUP; file-watch lands with an ops-tools plan).
