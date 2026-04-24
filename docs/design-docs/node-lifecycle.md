---
title: Node lifecycle (NodeBook, QuoteRefresher, health + circuit breaker)
status: accepted
last-reviewed: 2026-04-24
---

# Node lifecycle

How WorkerNodes enter, run in, and leave the bridge's routing pool.

## Source of truth: `nodes.yaml`

Config-driven allowlist. The file path is passed to the bridge process; SIGHUP triggers a safe reload. Shape (Appendix B of `docs/references/openai-bridge-architecture.md`, extended with per-node knobs):

```yaml
nodes:
  - id: node-a # stable logical id; also the node_health PK
    url: https://node-a.example.com # base URL for /health and /quote
    ethAddress: '0xabcd...' # Ethereum address the node receives tickets at
    supportedModels: ['model-small']
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

## `/health` contract (required on every WorkerNode)

```
GET /health
```

Response:

```json
{ "status": "ok" | "degraded", "models": ["model-small", ...], "detail": "optional" }
```

- `ok` — node is ready to serve inference. Router may route.
- `degraded` — node is reachable but self-reports reduced capacity. Router still considers it healthy for admission; operators should monitor the `degraded` count. A dedicated degraded→broken escalation policy is future work.
- Anything else (non-2xx, body fails the schema, timeout) — treated as a failure; counts against the circuit breaker.

Health probes run on the same cadence as quote refresh (one HTTP request per node per `quoteRefreshSeconds`), with separate timeouts for each endpoint.

## `/quote` contract

```
GET /quote
```

Response (wire format — bigints as base-10 strings to survive JSON):

```json
{
  "ticketParams": {
    "recipient": "0x...",
    "faceValueWei": "1000000000",
    "winProb": "100",
    "seed": "deadbeef",
    "expirationBlock": "1000",
    "expirationParamsHash": "hash..."
  },
  "priceInfo": { "pricePerUnitWei": "1000", "pixelsPerUnit": "1" },
  "lastRefreshedAt": "2026-05-01T00:00:00Z",
  "expiresAt": "2026-05-01T00:05:30Z"
}
```

Validated by `NodeQuoteResponseSchema` in `src/providers/nodeClient.ts`. Strings are coerced to `bigint` at this boundary; downstream code sees the domain-level `Quote` type from `src/types/node.ts`.

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

## Routing (0007 will consume this)

```
NodeBook.findNodesFor(model, tier): NodeEntry[]
```

Filters nodes by `enabled`, supported model, allowed tier, and circuit status (`circuit_broken` excluded). Sorts by `weight` descending. Router in 0007 is responsible for the actual selection policy; NodeBook just returns the admission set.

`NoHealthyNodesError` thrown when nothing matches (mapped to customer-facing `model_unavailable`).

## Out of scope (logged in tech-debt)

- Open node discovery via Livepeer subgraph / on-chain registry.
- Event retention sweeps (at current volume, not needed).
- Degraded→broken escalation policy (v1 treats `degraded` as routable).
- File-watch auto-reload (v1 relies on explicit SIGHUP; file-watch lands with an ops-tools plan).
