---
id: 0009
slug: rate-limiter
title: Redis sliding-window rate limiter + concurrency semaphore
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Implement `service/rateLimit`: per-customer sliding window (requests/min, requests/day) + concurrent-request semaphore. Fail-open on Redis outage. Emit OpenAI-compatible 429 responses.

Depends on: `0004-auth-layer` (customer resolution).

## Non-goals

- No per-endpoint limits for v1. Global + per-tier only.
- No per-IP limits on authenticated routes (only signup).
- No distributed fairness. Best-effort via Redis.

## Approach

- [x] `providers/redis` adapter with connection, reconnection, health check — `src/providers/redis.ts` interface + `src/providers/redis/ioredis.ts` default impl.
- [x] Sliding-window via Redis ZSET Lua script (purge-old + count + conditional-add, atomic) — `src/service/rateLimit/slidingWindow.ts`.
- [x] Concurrency semaphore via INCR + 300 s TTL safety net, bounded-DECR Lua — `src/service/rateLimit/concurrency.ts`.
- [x] Tier-configured limits: free = 3/min, 200/day, 1 concurrent; prepaid = 60/min, 10k/day, 10 concurrent — `src/config/rateLimit.ts`.
- [x] Middleware: chained Fastify preHandler after auth — `src/runtime/http/middleware/rateLimit.ts`.
- [x] Response headers on every request: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`; `retry-after` on 429.
- [x] Fail-open behavior: every Redis call wrapped in try/catch; on error `failedOpen: true` flag and request proceeds.
- [x] Tests: `src/config/rateLimit.test.ts` (policy lookup), `src/service/rateLimit/rateLimit.test.ts` (6 tests with real Redis via Testcontainers — burst → 429, concurrency cap + recovery, isolation between customers, fail-open, resetSeconds bounds).
- [ ] Metrics: `rate_limit.fail_open` counter is planned at the log-statement level; a full Prometheus sink lands with a separate ops plan.

## Decisions log

### 2026-04-24 — Redis client: `ioredis`

Reason: Architecture reference default. Mature, TS-ready, auto-reconnect, cluster-aware when/if we need it. `node-redis` (the official) is defensible but doesn't buy anything 0009 needs. All Redis access is funneled through `src/providers/redis/`, so swapping later is a one-file change.

### 2026-04-24 — Sliding-window via Redis ZSET + Lua script

Reason: Sliding-window-log (one ZSET entry per request, keyed by timestamp) is the accurate algorithm. At v1 scale (free tier: 3 req/min ceiling, prepaid: 60) memory is trivial. A single Lua script performs purge-old + count + conditional-add atomically; returns `{ allowed, limit, count, resetMs }` so the preHandler can both decide and set response headers from one round-trip. Blended-counter approximation rejected — accuracy beats memory at our scale.

### 2026-04-24 — Concurrency semaphore: Redis counter + 300 s TTL safety net

Reason: `rl:{customerId}:concurrent` key. `INCR` on enter; if result > limit, immediately bounded-DECR and return 429. `DECR` on handler exit (finally). `EXPIRE 300s` after each INCR ensures an orphaned slot (bridge crash before DECR) rolls off cleanly. Bounded-DECR (`MAX(count-1, 0)`) implemented as a small Lua helper to prevent negative counts under concurrent decrement.

### 2026-04-24 — Fail-open on any Redis error

Reason: Per architecture reference §5.8. Rate limiting is protective, not billing-critical. A Redis outage must not take down the API. Every `ratelimiter` entry point wraps Redis ops in try/catch; on error it logs WARN, increments a `rate_limit.fail_open` metric counter, and allows the request. Tested explicitly with a test that takes Redis down.

### 2026-04-24 — Tier policies embedded in `src/config/rateLimit.ts`; keyed on `customer.rateLimitTier`

Reason: v1 ships with three named policies:

- `free-default` — 3 req/min, 200 req/day, 1 concurrent.
- `prepaid-default` — 60 req/min, 10_000 req/day, 10 concurrent.
- `prepaid-pro` — reserved, unset in v1 (dynamic policy loading is tech-debt).

`customer.rateLimitTier` (column already in 0003 schema) keys the lookup. Unknown names fall back to `prepaid-default` with a WARN — safer than rejecting the request on config drift.

### 2026-04-24 — `x-ratelimit-*-requests` headers on every response; `retry-after` on 429

Reason: OpenAI SDK and other clients use these headers to back off preemptively. Emitting them on every request (not just 429) reduces the need for clients to discover limits the hard way. Set:

- `x-ratelimit-limit-requests` (per-minute limit)
- `x-ratelimit-remaining-requests`
- `x-ratelimit-reset-requests` (seconds until window rolls)
- `retry-after` on 429 only

Token-based headers (`x-ratelimit-*-tokens`) are out of scope until 0011 lands LocalTokenizer — without credible token counts we'd be guessing.

## Open questions

- Per-endpoint limits (e.g., separate policy for `/v1/chat/completions` vs. a future `/v1/embeddings`) — deferred.
- Token-based rate limiting — deferred until 0011 provides the counts.
- Distributed fairness (concurrent requests per-region vs. global) — single-region v1 does not need this.

## Artifacts produced

- Providers: `src/providers/redis.ts` (interface) + `src/providers/redis/ioredis.ts` (default ioredis impl). Added as the second cross-cutting provider pattern alongside `nodeClient`.
- Config: `src/config/redis.ts` (Zod env → `RedisConfig`) + `src/config/rateLimit.ts` (policy map with free-default / prepaid-default).
- Service: `src/service/rateLimit/` — `slidingWindow.ts` (Lua script for atomic window check), `concurrency.ts` (semaphore with bounded-DECR Lua), `errors.ts` (`RateLimitExceededError` with `reason: per_minute | per_day | concurrent`), `index.ts` (factory + `RateLimiter` interface), `testRedis.ts` (Testcontainers helper; CI env-override same pattern as testPg).
- Runtime: `src/runtime/http/middleware/rateLimit.ts` Fastify preHandler; chained after auth in `registerChatCompletionsRoute`.
- Error mapping: `toHttpError` in `src/runtime/http/errors.ts` now maps `RateLimitExceededError` → 429 `rate_limit_exceeded`.
- CI: `.github/workflows/test.yml` adds a `services: redis` block (redis:7-alpine) + `TEST_REDIS_HOST` / `TEST_REDIS_PORT` env.
- Coverage exclusion: `src/**/testRedis.ts` added to `vitest.config.ts` exclude (test infra, not production code).
- Tests (179 total passing, 8 new for 0009; 94.09% stmt / 83.3% branch / 97.29% func / 94.09% line).
- Tech-debt: per-endpoint policies, token-based headers (post-0011), Redis pub/sub invalidation of the auth cache, distributed fairness.
