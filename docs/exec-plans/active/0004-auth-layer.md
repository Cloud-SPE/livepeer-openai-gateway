---
id: 0004
slug: auth-layer
title: AuthLayer — API key validation and tier enforcement
status: active
owner: unassigned
opened: 2026-04-24
---

## Goal

Implement `service/auth`: API key issuance, validation, customer lookup, tier resolution, basic rate-limit pre-check. Every HTTP handler funnels through this layer; no handler may hit the database directly for auth.

Depends on: `0003-customerledger` (customer persistence).

## Non-goals

- No signup flow. That lives in `runtime/signup/` and may be a later plan.
- No detailed rate-limit enforcement — that's `0009-rate-limiter`. AuthLayer does coarse checks only (e.g., suspended account).
- No OAuth, no JWT. API keys only for v1.

## Approach

- [ ] API key format: `sk-<env>-<random>` with version prefix for future rotation
- [ ] Key issuance: generate, hash (bcrypt or argon2), persist `api_key_hash` on customer record
- [ ] Validation: constant-time hash comparison; cache lookups in memory with short TTL
- [ ] `service/auth.authenticate(req) → Customer | AuthError`
- [ ] Suspension check: if `customer.status !== 'active'`, reject with 401
- [ ] Middleware factory for HTTP handlers
- [ ] Middleware factory for gRPC interceptors (forward use)
- [ ] Tests: valid key → customer, invalid key → 401, suspended → 401, timing-safe comparison

## Decisions log

_(empty)_

## Open questions

- Hash algorithm: argon2id vs bcrypt? Argon2id is current best practice; bcrypt is battle-tested. Lean argon2id.
- Cache TTL: too long = stale revocation; too short = DB load. Start at 60s, revisit with metrics.
- Key rotation: does v1 support multiple active keys per customer? Nice-to-have, keep in mind but can defer.

## Artifacts produced

_(to be populated on completion)_
