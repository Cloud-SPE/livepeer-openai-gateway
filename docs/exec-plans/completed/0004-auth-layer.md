---
id: 0004
slug: auth-layer
title: AuthLayer — API key validation and tier enforcement
status: completed
owner: claude
opened: 2026-04-24
closed: 2026-04-24
---

## Goal

Implement `service/auth`: API key issuance, validation, customer lookup, tier resolution, basic rate-limit pre-check. Every HTTP handler funnels through this layer; no handler may hit the database directly for auth.

Depends on: `0003-customerledger` (customer persistence).

## Non-goals

- No signup flow. That lives in `runtime/signup/` and may be a later plan.
- No detailed rate-limit enforcement — that's `0009-rate-limiter`. AuthLayer does coarse checks only (e.g., suspended account).
- No OAuth, no JWT. API keys only for v1.

## Approach

- [x] API key format: `sk-<env>-<base64url 32 random bytes>` enforced by `API_KEY_PATTERN` regex
- [x] Key issuance: generate, HMAC-SHA-256 with server-side pepper, persist on `api_key` table (multi-key per customer from day one)
- [x] Validation: `timingSafeEqual` on hex hashes; in-process TTL cache with 60 s default
- [x] `service/auth.createAuthService({db, config}).authenticate(header) → AuthenticatedCaller | AuthError`
- [x] Suspension check: `AccountSuspendedError` / `AccountClosedError` when `status !== 'active'`
- [x] Middleware factory for HTTP handlers: `runtime/http/middleware/auth.ts` as a Fastify `preHandler` that attaches `req.caller = { customer, apiKey }`
- [x] Middleware factory for gRPC interceptors — deferred (no inbound gRPC surface exists); logged in tech-debt-tracker.md
- [x] Tests: 23 new tests — key format, HMAC determinism, timing-safe compare, TTL expiry, issue→authenticate→revoke flow, suspended/closed accounts, malformed headers, Fastify 200/401 round-trips

## Decisions log

### 2026-04-24 — Hash with HMAC-SHA-256 + server-side pepper (not argon2id / bcrypt)

Reason: API keys are 32 bytes of CSPRNG randomness (~256 bits of entropy). Argon2/bcrypt are designed for **low-entropy** passwords where GPU brute-force is the threat — running them on every authenticated request adds 10–200ms of latency for zero security gain against a key space no attacker can brute-force. Industry standard for high-entropy API tokens is HMAC-SHA-256 with a pepper (AWS IAM, GitHub PATs, Stripe restricted keys): sub-microsecond verify, timing-safe comparison, pepper rotatable without touching plaintext keys. If the DB is stolen without the pepper, the hashes are useless; if the pepper is stolen, the keys themselves are still unguessable.

### 2026-04-24 — Multi-key table (`api_key`) from day one; drop `customer.api_key_hash`

Reason: 0002's type layer already anticipates this (`ApiKey`, `ApiKeyId`), and key rotation without downtime requires at least two active keys per customer. Adding it later would force a three-step migration (table → backfill → drop column); adding it now — before prod — is a single clean migration. `customer.api_key_hash` is dropped outright since no rows exist yet.

### 2026-04-24 — Fastify as the HTTP framework

Reason: v1 needs first-class SSE (0008 streaming chat completions), a Stripe webhook that consumes raw request bodies (0010), and async hooks that compose cleanly for auth (this plan). Fastify ships all three ergonomically; Express makes streaming awkward and raw-body handling require a pre-parser dance. This commitment binds 0007/0008/0010 — picking it once here avoids writing auth twice.

### 2026-04-24 — In-memory LRU cache with 60 s TTL; no Redis yet

Reason: plan default. Accepts up to 60 s of revocation latency as the v1 tradeoff. Redis-based cache invalidation (instant revocation via pub/sub) waits for 0009-rate-limiter when Redis arrives for rate limiting; shipping it here would mean standing up Redis for a single use case.

### 2026-04-24 — Server-side gRPC interceptor deferred (`forward use` stays forward)

Reason: The bridge has no inbound gRPC surface in any documented roadmap. `livepeer-payment-library`'s PayerDaemon is a gRPC server that we call as a client (see 0006-payer-client); bridge↔daemon wire-level auth (shared secret, mTLS) is a client-side metadata concern for 0006, not a server interceptor here. Writing a server-side interceptor now would be for a use case that does not exist. Logged in tech-debt-tracker.md.

## Open questions

- Pepper supply in production: env var (v1 default) vs AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault. Logged in tech-debt; v1 stays on env.
- `last_used_at` update cadence: every request (simple, extra write per call) vs debounced (e.g., once per minute per key). Start with every-request; revisit if the write cost shows up in p99 latency.

## Artifacts produced

- Schema: migration `migrations/0001_melodic_boom_boom.sql` — adds `api_key` table (id, customer_id, hash, label, created_at, last_used_at, revoked_at), drops `customer.api_key_hash`, indexes on hash and customer_id.
- Repo adapter: `src/repo/apiKeys.ts` — insert, findActiveByHash (joins customer), findById, revoke, markUsed.
- Config: `src/config/auth.ts` — Zod-validated env → `AuthConfig` (pepper, env prefix, cache TTL).
- Service: `src/service/auth/` — `keys.ts` (generate / hash / verify / issueKey / revokeKey), `cache.ts` (TtlCache), `authenticate.ts` (createAuthService), `errors.ts` (MalformedAuthorizationError, InvalidApiKeyError, AccountSuspendedError, AccountClosedError).
- Providers: `src/providers/http.ts` (HttpServer interface) + `src/providers/http/fastify.ts` (default impl with `@fastify/sensible`).
- Runtime middleware: `src/runtime/http/middleware/auth.ts` — Fastify preHandler that maps AuthError → 401 ErrorEnvelope and attaches `req.caller`.
- Tests (67 total, 23 new for 0004): `src/service/auth/{keys,cache,auth}.test.ts`, `src/config/auth.test.ts`, `src/runtime/http/middleware/auth.test.ts`. Coverage 99.53% stmt / 88.63% branch / 98.38% func / 99.53% line.
- Tech-debt entries: server-side gRPC interceptor deferred; Redis pub/sub cache invalidation deferred; pepper-in-env → secret-manager pre-launch.
