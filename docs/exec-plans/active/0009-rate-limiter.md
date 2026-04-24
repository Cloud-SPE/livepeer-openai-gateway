---
id: 0009
slug: rate-limiter
title: Redis sliding-window rate limiter + concurrency semaphore
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement `service/rateLimit`: per-customer sliding window (requests/min, requests/day) + concurrent-request semaphore. Fail-open on Redis outage. Emit OpenAI-compatible 429 responses.

Depends on: `0004-auth-layer` (customer resolution).

## Non-goals

- No per-endpoint limits for v1. Global + per-tier only.
- No per-IP limits on authenticated routes (only signup).
- No distributed fairness. Best-effort via Redis.

## Approach

- [ ] `providers/redis` adapter with connection, reconnection, health check
- [ ] Sliding-window counter via Redis Lua script (atomic increment + expire)
- [ ] Concurrency semaphore via Redis keys with TTL safety net
- [ ] Tier-configured limits: free = 3/min, 200/day, concurrency=1; prepaid = configurable
- [ ] Middleware: check → proceed or 429
- [ ] 429 response with OpenAI-compatible headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`
- [ ] Fail-open behavior: Redis unreachable → log warning, allow request
- [ ] Tests: window expiry, concurrency cap, fail-open path
- [ ] Metrics: limit hits per tier

## Decisions log

_(empty)_

## Open questions

- Lua script vs Redis commands: Lua is atomic but harder to debug. Start with Lua.
- How do we release semaphore slots on crashes? TTL safety net (e.g., 5min) covers orphaned slots without manual cleanup.
- Free-tier concurrent=1: enforced strictly or soft warn? Strict 429.
- Multiple API keys per customer: limits per-customer (recommended) or per-key? Per-customer is the norm.

## Artifacts produced

_(to be populated on completion)_
