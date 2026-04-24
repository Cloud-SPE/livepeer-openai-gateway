---
id: 0005
slug: nodebook
title: NodeBook — config loader, QuoteRefresher, health checks
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement `service/nodes`: config-driven WorkerNode registry with live quote refresh, health tracking, and circuit-breaker behavior. Router (future plan) reads from NodeBook.

Depends on: `0002-types-and-zod` (NodeConfig/NodeState shapes).

## Non-goals

- No open discovery via Livepeer subgraph. Deferred to v2.
- No Router implementation. That's consumed by the streaming/non-streaming endpoint plans.
- No auto-onboarding UI.

## Approach

- [ ] Config schema: `nodes.yaml` per Appendix B of `docs/references/openai-bridge-architecture.md`
- [ ] Config loader: watches file for SIGHUP reload
- [ ] NodeBook in-memory state: config ∪ quote ∪ health ∪ capacity
- [ ] NodeBook persistence for health history in Postgres (so circuit-break state survives restart)
- [ ] QuoteRefresher background loop: polls each node's `GetQuote` every N seconds (configurable)
- [ ] Health check: HTTP HEAD or dedicated `/health` endpoint? Decide in decisions log
- [ ] Circuit-breaker: N consecutive failures → break, cool-down T seconds → half-open → retry
- [ ] Query API for Router: `findNodesFor(model, tier) → NodeState[]` sorted by readiness
- [ ] Author `docs/design-docs/node-lifecycle.md`

## Decisions log

_(empty)_

## Open questions

- Health-check mechanism: HTTP HEAD on the node URL, a dedicated `/health` endpoint we require nodes to expose, or the first real request as the probe? Lean dedicated `/health`.
- Quote refresh cadence: every 30s? Quotes include ticket expiration blocks, so should be faster than expiration window.
- Health history retention: how far back do we keep? 7d enough for troubleshooting; trim older.
- What happens if a node changes its `eth_address` mid-operation (key rotation)? Treat as a new node; flag config in NodeBook.

## Artifacts produced

_(to be populated on completion)_
