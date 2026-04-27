# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
post-1.0.

## [Unreleased]

## [0.1.0] - 2026-04-XX

### Added

- Initial extraction from the `openai-livepeer-bridge` monorepo (now
  `livepeer-openai-gateway`). The engine ships as
  `@cloudspe/livepeer-gateway-core`.
- Adapter interfaces (operator-overridable):
  - `Wallet` (reserve / commit / refund; multi-unit cost via cents +
    wei + estimatedTokens).
  - `AuthResolver` (turns an HTTP `Authorization` header into a
    generic `Caller`).
  - `RateLimiter` (per-caller request gating with a Redis
    sliding-window default impl).
  - `Logger` (structured log sink; `createConsoleLogger` default).
  - `AdminAuthResolver` (admin-token / basic-auth backing for the
    optional operator dashboard).
- Provider interface (engine-internal, not operator-overridable):
  - `ServiceRegistryClient` — gRPC client for
    [`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon).
- Framework-free dispatchers under `@cloudspe/livepeer-gateway-core/dispatch/`:
  chat completions (streaming + non-streaming), embeddings, image
  generations, audio speech, audio transcriptions.
- Fastify adapter at `@cloudspe/livepeer-gateway-core/runtime/http/*`
  registering OpenAI-compatible routes (`/v1/chat/completions`, etc.),
  the auth + rate-limit middleware, the metrics hook, and the
  HTTP-error mapping layer.
- Optional read-only operator dashboard at
  `@cloudspe/livepeer-gateway-core/dashboard` — vanilla server-rendered
  HTML, no client framework or build step.
- `InMemoryWallet` reference implementation for testing
  (`@cloudspe/livepeer-gateway-core/service/billing/inMemoryWallet.js`).
- Hand-rolled migration runner with a `public.bridge_schema_migrations`
  tracker; engine schema in `migrations/0000_engine_init.sql`
  (`engine.node_health`, `engine.node_health_events`,
  `engine.usage_records` keyed by opaque `caller_id` text — no FK
  into shell schemas).
- Prometheus recorder with cardinality-cap protection on every label
  vec; engine metrics under the `livepeer_bridge_*` prefix; build-info
  gauge `livepeer_bridge_engine_build_info`.
- Shell-emitted metrics (Stripe API + webhooks, top-ups, reservations
  gauges) under the `cloudspe_*` prefix; `setShellBuildInfo()` emits
  `cloudspe_app_build_info`.
- `examples/wallets/{postpaid,prepaid-usd,free-quota}.ts` — three
  illustrative Wallet stubs adopters can copy and adapt.
- `examples/minimal-shell/` — runnable example using `InMemoryWallet`
  + a no-op AuthResolver so adopters can clone-and-run in 30 seconds.

[Unreleased]: https://github.com/Cloud-SPE/livepeer-gateway-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Cloud-SPE/livepeer-gateway-core/releases/tag/v0.1.0
