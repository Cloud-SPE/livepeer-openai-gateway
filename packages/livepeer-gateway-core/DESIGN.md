# DESIGN — `@cloudspe/livepeer-gateway-core`

## What this is

A **request engine**: a Node library that takes an OpenAI-compatible
HTTP request, runs it through a fixed dispatch pipeline, and
returns an OpenAI-compatible response. The pipeline is the same
across all five capabilities (chat completion, embeddings, images,
speech, transcriptions):

```
HTTP request
  → AuthResolver.resolve(headers) → Caller
  → RateLimiter.check(callerId, tier) → reservation slot
  → Wallet.reserve(caller, costQuote) → ReservationHandle | null | throw
  → ServiceRegistryClient.select({capability, model, tier}) → NodeRef[]
    → CircuitBreaker.currentExclusions filters
    → weighted-random pick by NodeRef.weight
  → NodeClient.{call|stream}<capability>(nodeUrl, request, payment)
  → tokenAudit + usage + cost reconciliation
  → Wallet.commit(caller, handle, usageReport) | Wallet.refund on failure
  → write engine.usage_records row
  → return OpenAI-shaped response
```

Every step is an interface call into either an operator-supplied
adapter or an engine-internal provider. The orchestration is
hard-coded — the variation lives in adapter impls.

## What this is NOT

- **Not a billing system.** The `Wallet` adapter is operator code.
  The engine asks "may this caller spend up to N cents/wei/tokens?"
  and reports actuals; the wallet decides what that means.
- **Not an identity provider.** The `AuthResolver` adapter is
  operator code. The engine receives an opaque `Caller.id` /
  `tier` / `rateLimitTier` and threads them through.
- **Not a multi-protocol gateway.** Strictly OpenAI-compatible.
  Other shapes belong in a fork or a sibling engine.
- **Not a discovery system.** Node identity comes from the
  service-registry-daemon over gRPC. The engine pins the daemon's
  contract.

## Why an engine + adapters split

Three operator deployments motivate the split:

1. **Cloud-SPE shell** (`Cloud-SPE/livepeer-openai-gateway`) — prepaid
   USD billing via Postgres + Stripe; API-key auth; Redis sliding
   window rate limit; admin dashboard.
2. **Postpaid B2B operator** — invoiced monthly; bearer-token auth
   from an SSO IdP; in-memory rate limit; minimal admin surface.
3. **Free-quota tier** — token allowance reset monthly; opaque header
   API keys; aggressive rate-limit; community moderation queue.

All three share **the same** dispatcher pipeline, OpenAI request/
response shape, payment-daemon integration, ticket-creation logic,
worker-call mechanics, retry policy, circuit breaker, token audit,
and metric surface. The engine handles all of that.

The variation is entirely in the five adapters:

| Adapter | Cloud-SPE shell | Postpaid B2B | Free-quota |
|---------|----------------|--------------|------------|
| Wallet | prepaid USD via Postgres + Stripe | postpaid: null reserve, commit on usage | token allowance, monthly reset |
| AuthResolver | API-key bearer | SSO bearer | opaque header key |
| RateLimiter | Redis sliding window | in-memory | aggressive Redis |
| Logger | console | pino → Datadog | console |
| AdminAuthResolver | basic auth | mTLS | basic auth |

Forking is permitted under MIT but not encouraged. The adapter
surface is meant to absorb deployment-specific work without
forking. If your deployment doesn't fit, tell us — that's the kind
of feedback that improves the contract.

## Engine boundaries (deeper)

### `ServiceRegistryClient` is engine-internal

The engine commits to the
[`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon)
as the canonical discovery source. Operators with proprietary
discovery systems should run a daemon shim instead of swapping
the engine's gRPC client.

The interface is exported (`@cloudspe/livepeer-gateway-core/providers/serviceRegistry.js`)
for two reasons: testability (stub for unit tests; see
`createFakeServiceRegistry`) and transparency (see what calls the
daemon makes). It is not on the operator-overridable list.

### Schema is namespaced under `engine`

The engine owns three tables in its own Postgres schema:

- `engine.node_health` — current circuit-breaker state per node.
- `engine.node_health_events` — append-only event log of breaker
  transitions and config-driven events.
- `engine.usage_records` — append-only request log with `caller_id`
  (opaque text), model, capability, tokens, cost.

There are NO cross-schema foreign keys from `engine.*` to any
operator-supplied table. The shell's `app.customers.id::text`
happens to match `engine.usage_records.caller_id`, but the engine
never resolves the join.

### Metric prefix split

- `livepeer_bridge_*` — engine-emitted metrics. Stable contract.
- `cloudspe_*` — Cloud-SPE-shell-emitted metrics. Stable contract
  for the shell, but the prefix is operator-renameable. Any
  operator can compose with the engine and emit under their own
  namespace.

The engine's `setShellBuildInfo()` Recorder method is a courtesy
hook for the shell; operators emit their own gauges directly via
the prom-client `Registry` they share with the engine.

### Two daemons are required

- `livepeer-payment-daemon` — sender mode, gRPC over unix socket.
  The engine pins the gRPC contract from the
  [`livepeer-payment-library`](https://github.com/livepeer-modules-project/livepeer-payment-library)
  repo.
- `livepeer-service-registry-daemon` — resolver mode, gRPC over
  unix socket. Engine pins the contract from
  [`service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon).

The reference compose stack (`examples/minimal-shell/compose.yaml`)
brings both up.

`livepeer-modules-project/protocol-daemon` is **orthogonal** —
orchestrator-side concern, not needed by gateway operators.

## Stability commitments

### Pre-1.0 (current state)

- Adapter shapes may break in any minor release. Every break is in
  `CHANGELOG.md` under `### Changed`.
- Pin to `^0.1.0` style range; bump explicitly.
- 1.0 ships when the first external operator successfully runs in
  production on this engine and signs off on the contracts.

### Post-1.0

- Strict [SemVer](https://semver.org/).
- Adapter changes → major bump + migration guide.
- Schema changes → major bump + migration script in
  `migrations/`.
- Metric renames → major bump + side-by-side dual-emit period for
  two minor releases.

## Trade-offs and known issues

- **Engine sampler queries `app.reservations`**. The metrics
  sampler emits `livepeer_bridge_reservations_open*` by reading
  shell-owned `app.reservations` directly via cross-schema SQL.
  This is a layering smell flagged in the source. A future minor
  release inverts the dependency via an injected
  reservation-count callback; for now, operators not running the
  Cloud-SPE shell can either provision an `app.reservations` table
  with the same shape or accept that the gauge will read zero.
- **Engine route unit tests are integration-test-only.**
  `runtime/http/{chat,embeddings,images,audio}/*` and
  `dispatch/*` are exercised via the Cloud-SPE shell's e2e
  tests, not via standalone engine-package unit tests. The engine
  vitest config excludes them from its 75% gate. A follow-up adds
  proper engine-side unit tests with `InMemoryWallet`.
- **Drizzle-kit migration metadata is not in this repo.** The
  custom migration runner uses a `public.bridge_schema_migrations`
  tracking table indexed by file basename, not drizzle-kit's
  `meta/_journal.json` format. This decouples us from drizzle-kit
  for the migration runtime; reintroducing `db:generate` requires
  seeding the meta files.
- **`node_health_events` is not partitioned.** Plan called for
  monthly partitioning at table creation time to amortize
  retention; deferred for the transitional schema. Operators with
  high node-churn workloads should partition manually.

## See also

- [`README.md`](README.md) — quickstart and ecosystem map.
- [`AGENTS.md`](AGENTS.md) — contributor process.
- [`docs/architecture.md`](docs/architecture.md) — layer stack +
  dispatcher pipeline detail.
- [`docs/adapters.md`](docs/adapters.md) — adapter contracts and
  patterns.
- [`docs/design-docs/`](docs/design-docs/) — focused notes on
  node lifecycle, payer integration, pricing model, streaming
  semantics, token audit, retry policy, metrics.
