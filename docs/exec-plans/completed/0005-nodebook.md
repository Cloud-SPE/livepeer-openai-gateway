---
id: 0005
slug: nodebook
title: NodeBook — config loader, QuoteRefresher, health checks
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Implement `service/nodes`: config-driven WorkerNode registry with live quote refresh, health tracking, and circuit-breaker behavior. Router (future plan) reads from NodeBook.

Depends on: `0002-types-and-zod` (NodeConfig/NodeState shapes).

## Non-goals

- No open discovery via Livepeer subgraph. Deferred to v2.
- No Router implementation. That's consumed by the streaming/non-streaming endpoint plans.
- No auto-onboarding UI.

## Approach

- [x] Config schema: `nodes.yaml` with Zod validation + per-node knob overrides (refresh cadence, timeouts, breaker thresholds).
- [x] Config loader: `createNodesLoader` + `reload()` method; SIGHUP wiring lands with the process entrypoint (separate ops-tools plan; loader is ready).
- [x] NodeBook in-memory state: config ∪ circuit ∪ quote per node; `findNodesFor(model, tier)` admission query.
- [x] NodeBook persistence — `node_health` (current snapshot, survives restart) + `node_health_event` (append-only state-transition log).
- [x] QuoteRefresher background loop: scheduler-injected, per-node reschedule via `quoteRefreshSeconds`.
- [x] Health check: dedicated `GET /health` contract specified in `docs/design-docs/node-lifecycle.md`.
- [x] Circuit-breaker: pure state machine with injected clock; defaults 5 failures / 30 s cool-down / one half-open probe; configurable per-node.
- [x] Query API for Router: `findNodesFor(model, tier) → NodeEntry[]` sorted by weight, excludes circuit-broken.
- [x] Author `docs/design-docs/node-lifecycle.md`.

## Decisions log

### 2026-04-24 — Health check: dedicated `GET /health` on each WorkerNode

Reason: HEAD probes fail on most inference stacks (405 or unimplemented). Using a real inference request as the probe conflates health with load-induced errors and wastes a paid call. A dedicated `/health` endpoint forces a clear contract (200 + JSON body ⇒ ready), cleanly separates from traffic, and supports circuit-breaker half-open probes without spending a customer's budget. Contract is specified in `docs/design-docs/node-lifecycle.md`.

### 2026-04-24 — Quote refresh cadence: 30 s default, configurable per-node

Reason: Ticket expiration is ~1 round (~5.5 min on mainnet). 30 s gives ~10 refreshes per expiration window, so the router always sees fresh `TicketParams`. At 3–5 nodes and one request per node per 30 s, load is negligible (<0.2 rps total). Per-node override in `nodes.yaml` (`quote_refresh_seconds`).

### 2026-04-24 — Circuit-breaker defaults: 5 failures → open, 30 s cool-down, 1 half-open probe

Reason: Industry-standard defaults. 5 consecutive failures distinguishes a real node outage from transient timeouts. 30 s cool-down is long enough for a typical node restart, short enough that customers don't notice extended loss of a node. Single half-open probe: on success, circuit closes and normal polling resumes; on failure, circuit re-opens with a fresh 30 s cool-down. All three values overridable in `nodes.yaml`.

### 2026-04-24 — Persistence: `node_health` (current state) AND `node_health_event` (append-only transitions)

Reason: `node_health` is a single row per node, updated every tick — fast lookup on restart so circuit state survives. `node_health_event` logs only **state transitions** (circuit open / half-open / close, config reload, eth_address rejection) — lean enough to keep indefinitely without retention machinery, informative enough to rebuild an ops timeline. We deliberately do NOT log every successful probe to keep the event stream signal-dense.

### 2026-04-24 — ETH address mid-flight change is a hard reload failure

Reason: If a running node's `eth_address` changes at reload, all open payment sessions on PayerDaemon are stranded (the old address on tickets no longer matches the new address the node claims). Silent acceptance would corrupt accounting. Instead: at reload, diff the old and new YAML, and if any existing `node_id` has a different `eth_address`, reject the reload and log a `node_health_event` of kind `eth_address_changed_rejected`. Operators must deliberately renumber the node (new `node_id`) so the old one drains cleanly.

### 2026-04-24 — HTTP client to nodes: built-in `fetch` with `AbortSignal.timeout()`

Reason: Node 20+ ships `fetch`. For v1's load (3–5 nodes × one GET every 30 s), connection pooling and streaming are unnecessary. Deferring `undici` keeps 0005 minimal; if 0007/0008 need streaming from nodes, we introduce undici there as a provider swap — the `NodeClient` interface already lets us. Request timeouts via `AbortSignal.timeout(ms)`; default 5 s for `/health`, 10 s for `/quote`.

## Open questions

- `/health` response shape: strict schema (Zod) vs loose "any 200 is healthy"? Loose is simpler but hides degraded states. Pinning: Zod schema with `{ status: "ok" | "degraded", models: string[] }`; degraded is reported but still routable.
- `node_health_event` retention: kept indefinitely in v1 (append-only, ~1 event per incident, tiny volume). Logged in tech-debt for revisit at scale.

## Artifacts produced

- Schema: migration `migrations/0002_lonely_thunderbolts.sql` — adds `node_health` (current state, `node_id` PK) and `node_health_event` (append-only transition log, indexed on `node_id, occurred_at`); new enums `node_health_status` and `node_health_event_kind`.
- Config: `src/config/nodes.ts` — YAML parsing, Zod validation (extends `NodeConfigSchema` with per-node knobs), `detectEthAddressChanges` diff helper.
- Providers: `src/providers/nodeClient.ts` (interface + wire schema with bigint coercion for ticket/price fields) + `src/providers/nodeClient/fetch.ts` (default fetch impl with `AbortSignal.timeout`).
- Repo: `src/repo/nodeHealth.ts` — upsert current state, insert events, list events per node.
- Service: `src/service/nodes/` — `circuitBreaker.ts` (pure state machine with injected clock), `nodebook.ts` (NodeBook class + findNodesFor), `scheduler.ts` (Scheduler interface + `ManualScheduler` for tests + `realScheduler`), `quoteRefresher.ts` (probe loop, persists snapshot + events), `loader.ts` (load + reload with eth_address diff guard), `errors.ts`.
- Tests (27 new for 0005; 94 total passing, 98.82% stmt / 86.88% branch / 98.19% func / 98.82% line): `src/config/nodes.test.ts`, `src/service/nodes/{circuitBreaker,nodebook,scheduler,nodes}.test.ts`.
- Design-doc: `docs/design-docs/node-lifecycle.md` (`status: accepted`).
- Tech-debt: open discovery (subgraph), event retention policy, nodes.yaml file-watch, routing strategy (for 0007).
