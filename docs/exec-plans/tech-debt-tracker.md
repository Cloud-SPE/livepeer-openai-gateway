# Technical debt tracker

Append-only list of known debt. Strike through when resolved; include the PR or exec-plan that resolved it.

## Format

```
### <short-title>
- Opened: YYYY-MM-DD
- Severity: low | medium | high
- Area: <layer or domain>
- Description: one paragraph
- Remediation: link to exec-plan or "TODO"
- Resolved: <YYYY-MM-DD in PR #nnn>  (add on close; strike-through the title)
```

## Items

### ~~layer-check ESLint plugin — stub only~~

- Opened: 2026-04-24
- Severity: medium
- Area: lint
- Description: `lint/layer-check/index.mjs` is currently a warn-and-exit-0 stub. The dependency rule from `docs/design-docs/architecture.md` (types → config → repo → service → runtime → ui + providers) is not yet enforced mechanically — CI will pass on violations.
- Remediation: dedicated exec-plan to author an AST-based layer-check (and the companion `no-cross-cutting-import`, `zod-at-boundary`, `no-secrets-in-logs`, `file-size` rules described in `lint/README.md`).
- Resolved: 2026-04-25 — debt entry was stale; the AST-based plugin shipped with exec-plan 0014 (`lint/eslint-plugin-livepeer-bridge/`, six rules at ~495 LOC, wired into `eslint.config.js` and `npm run lint`). Verified by re-running `npx eslint .` clean. One drive-by fix during verification: `src/types/capability.ts` gained the missing `CapabilityStringSchema` + `CapabilityString` type alias to satisfy the existing `livepeer-bridge/types-shape` rule (closed-set Zod enum of canonical capability strings, used at the worker-facing boundary).

### Server-side gRPC interceptor for auth — deferred

- Opened: 2026-04-24
- Severity: low
- Area: auth / runtime
- Description: 0004-auth-layer's plan mentions a middleware factory for gRPC interceptors as "forward use". The bridge has no inbound gRPC surface today (PayerDaemon is a gRPC server that we call as a client — see 0006-payer-client). No interceptor is implemented here; the authentication primitives in `src/service/auth/` are transport-agnostic and can be reused if an inbound gRPC endpoint ever lands.
- Remediation: revisit when any inbound gRPC endpoint is proposed.
- Resolved: _(open)_

### Redis pub/sub auth cache invalidation — deferred

- Opened: 2026-04-24
- Severity: low
- Area: auth
- Description: `TtlCache` in `src/service/auth/cache.ts` is per-process, with a 60 s TTL. Revoking a key can take up to 60 s to propagate across multiple bridge replicas. Acceptable for soft-launch scale; not acceptable for high-SLA revocation requirements.
- Remediation: when Redis is introduced in 0009-rate-limiter, add a `key:revoked` pub/sub channel that every `authService` subscribes to and calls `invalidate(hash)` on.
- Resolved: _(open)_

### API key pepper lives in plain env — tighten before production

- Opened: 2026-04-24
- Severity: medium
- Area: ops / auth
- Description: `API_KEY_PEPPER` is loaded from a plain env var. For soft-launch this is acceptable, but exposing the pepper via env means a misconfigured process dump or `/proc/*/environ` leak compromises every key hash in the DB.
- Remediation: before public launch, source the pepper from a secret manager (AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault) and zero the env var after read. Document the rotation runbook alongside the config.
- Resolved: _(open)_

### Open node discovery via Livepeer subgraph — deferred

- Opened: 2026-04-24
- Severity: low
- Area: service/nodes
- Description: 0005-nodebook ships the config-driven allowlist path. Open discovery (querying the Livepeer subgraph / on-chain registry to find available WorkerNodes) is deferred to v2 per `docs/references/openai-bridge-architecture.md` §11.
- Remediation: new exec-plan when we're ready to move off allowlist-only.
- Resolved: _(open)_

### `node_health_event` retention policy — not implemented

- Opened: 2026-04-24
- Severity: low
- Area: service/nodes / ops
- Description: Only state-transition events are logged (one event per incident), so volume is low. At current soft-launch scale there is no retention sweep; events accumulate indefinitely. At dashboard scale or after a year of production, a retention policy (e.g., >90d rolls off) will be warranted.
- Remediation: add a monthly cron job (or postgres partitioning) once the event count per day is measurable.
- Resolved: _(open)_

### nodes.yaml auto-reload via file-watch — deferred

- Opened: 2026-04-24
- Severity: low
- Area: service/nodes / ops
- Description: v1 requires SIGHUP for config reload. File-watching (`fs.watch` or `chokidar`) would give hands-off reloads but adds edge cases (editor save-rename semantics, partial writes). Kept deliberately simple for v1.
- Remediation: pick up with the ops-tools/deployment plan; decide whether watch belongs in the bridge or in an ops sidecar.
- Resolved: _(open)_

### Routing policy (weighted random vs least-in-flight) — 0007 decision

- Opened: 2026-04-24
- Severity: low
- Area: service/routing (future)
- Description: `NodeBook.findNodesFor` returns admission-set sorted by weight. The actual selection policy (weighted-random, round-robin, least-in-flight) is the Router's concern in 0007-chat-completions-nonstreaming. Noted so the decision isn't buried.
- Remediation: lock in 0007 with a decisions-log entry; likely weighted-random initially.
- Resolved: _(open)_

### ~~Proto stub auto-sync with livepeer-payment-library — manual for v1~~

- Opened: 2026-04-24
- Severity: low
- Area: providers/payerDaemon
- Description: `src/providers/payerDaemon/gen/` is regenerated by `npm run proto:gen` against the sibling library repo. Needed a CI check to catch silent schema drift.
- Remediation: 0015 ships `npm run proto:check` (regen + `git diff --exit-code`) and a `proto-drift` CI job. Also added `src/providers/payerDaemon/gen/**` to `.prettierignore` so Prettier no longer re-formats the generated stubs out from under codegen.
- Resolved: 2026-04-24 in exec-plan 0015-remaining-lints

### Real daemon smoke test (not fake gRPC server) — deferred to ops plan

- Opened: 2026-04-24
- Severity: medium
- Area: providers/payerDaemon
- Description: 0006 tests the client against a fake `@grpc/grpc-js` server that implements the same `PayerDaemonService` descriptor. A full smoke test — start the actual daemon binary from `livepeer-payment-library` and have the bridge exercise startSession / createPayment against it — would catch wire-format regressions that the fake server cannot. Requires standing up the daemon + its deps (BoltDB keystore, maybe a local Eth node or mock) in CI.
- Update 2026-05-01: the upstream `payment-daemon` sender API has since moved to `CreatePayment(face_value, recipient, capability, offering)` with no public `StartSession` / `CloseSession`. This debt item still applies in spirit, but the smoke target needs to be reframed around the currently pinned shell/runtime compatibility surface versus the newer upstream daemon contract when this repo upgrades `@cloudspe/livepeer-openai-gateway-core`.
- Remediation: ops/deployment plan that scripts the daemon binary startup and wires a bridge-side integration test.
- Resolved: _(open)_

### livepeer-payment-library npm publish + import cleanup — when the library ships

- Opened: 2026-04-24
- Severity: low
- Area: providers/payerDaemon
- Description: Bridge reads the library's proto directly from `../livepeer-payment-library/proto/`. That works while both repos are co-developed, but is not a durable packaging story. When the library publishes an artifact (npm package with pre-generated TS stubs, or a versioned proto package via buf.build), swap this path dependency for the artifact.
- Remediation: follow-on plan when the library reaches its first publishable release.
- Resolved: _(open)_

### Multi-replica migration race

- Opened: 2026-04-24
- Severity: medium
- Area: runtime / main
- Description: `BRIDGE_AUTO_MIGRATE=true` on boot is convenient for single-replica deploys but two replicas starting concurrently both try to run the same migration, racing on Drizzle's `__drizzle_migrations` table. Postgres serializes via locks, but the second replica waits until the first commits.
- Remediation: for multi-replica deploys, set `BRIDGE_AUTO_MIGRATE=false` and run a one-shot migration job (`npm run db:migrate` via `scripts/migrate.ts`) in a pre-deploy step.
- Resolved: _(open)_

### Testcontainers port race during parallel suite runs

- Opened: 2026-04-24
- Severity: low
- Area: tests
- Description: Running the full vitest suite spins up ~10 Postgres containers in parallel. Occasionally Docker's port allocator reports "address already in use" when a previous container's port hasn't fully released. Re-running passes.
- Remediation: cap vitest concurrency, or share a single container across files via globalSetup.
- Resolved: _(open)_

### ~~Payer-daemon Docker image~~

- Opened: 2026-04-24
- Severity: medium
- Area: deployment
- Description: The bridge's `compose.yaml` keeps the payer-daemon service block commented out because the library repo doesn't publish a container image yet. Local full-stack dev requires bringing your own daemon.
- Remediation: publish a sender-mode image from `livepeer-payment-library` (its own ops plan), then uncomment the block in `compose.yaml`.
- Resolved: 2026-04-24 in exec-plan 0016. Library published `tztcloud/livepeer-payment-daemon:v0.8.10`; `compose.yaml` wires it as the default `payment-daemon` service (sender mode), and `compose.prod.yaml` layers prod hardening. Socket path reconciled to the library's convention (`/var/run/livepeer/payment.sock`, `payment-socket` volume).

### CI workflow to build + push bridge image

- Opened: 2026-04-24
- Severity: low
- Area: ci
- Description: `Dockerfile` builds cleanly, but no GitHub Actions workflow builds/pushes on merge. Blocked on a registry decision (GHCR, Docker Hub, private).
- Update 2026-04-26: local recipe now in place via `npm run docker:{build,tag,push,release}` (see `docs/operations/deployment.md` "Building the production image"). Defaults to `tztcloud/livepeer-openai-gateway:v0.8.10`; overridable via `$BRIDGE_VERSION` and `$BRIDGE_IMAGE_REPO`.
- Resolved: 2026-04-30 in exec-plan 0034. `.github/workflows/release.yml` now publishes `tztcloud/livepeer-openai-gateway` on semver tag push after re-running format, lint, typecheck, docs, and tests. Release tags emitted: `3.0.1`, `3.0`, and `latest`.
- Remediation: one workflow file once the registry is picked. Skeleton already documented; copy and fill the registry login step.
- Resolved: _(open — manual recipe in place; CI workflow remains)_

### `src/types/` shape lint not enforced

- Opened: 2026-04-24
- Severity: low
- Area: lint / types
- Description: 0002-types-and-zod calls for a lint that asserts every file in `src/types/` exports both a Zod schema and the inferred `z.infer` type. Currently relying on code review. Convention is respected by every file authored in 0002.
- Remediation: add as a rule in the ESLint plugin work (see above).
- Resolved: 2026-04-25 — entry was stale; rule is implemented as `livepeer-bridge/types-shape` (lint/eslint-plugin-livepeer-bridge/rules/types-shape.js, 82 LOC) and is wired into `eslint.config.js`. Verified by `npx eslint .` running clean against `src/types/`.

### audio-endpoints-integration-test

- Opened: 2026-04-25
- Severity: low
- Area: tests / runtime/http/audio
- Description: 0019 shipped `/v1/audio/speech` and `/v1/audio/transcriptions` with unit-level coverage on the schemas, pricing helpers, and migration. Full integration tests against a fake worker node + fake gRPC daemon (mirroring the embeddings/images pattern) were deferred. End-to-end behaviour — multipart round-trip, header propagation, mid-stream cancellation, duration-missing 503+refund — is currently only covered by code review and the lint+typecheck surface.
- Remediation: extend `src/runtime/http/audio/{speech,transcriptions}.test.ts` with TestPg + fake daemon + fake worker, mirroring `src/runtime/http/embeddings/embeddings.test.ts`. Most fixtures (TestPg, fakeQuotesResponse, etc.) are already in place; new pieces are a fake `/v1/audio/speech` handler that emits `audio/mpeg` bytes and a fake `/v1/audio/transcriptions` handler that sets `x-livepeer-audio-duration-seconds`.
- Resolved: _(open)_

### model-tier-env-config

- Opened: 2026-04-25
- Severity: medium
- Area: src/config/pricing.ts
- Description: `V1_MODEL_TO_TIER` is hardcoded in source. Adding a new chat model (e.g. `gemma4:26b`, `llama3.1:8b`) requires a code change + image rebuild + republish, even though the model itself can be advertised via `worker.yaml` without touching the bridge. This is fine for first deploy but becomes a coordination tax once the worker fleet starts to accept multiple models.
- Remediation: introduce a `MODEL_TO_TIER` env var (e.g. `gemma4:26b=starter,llama3.1:8b=standard`) parsed at boot via Zod, merged on top of the hardcoded defaults. Operator can add a model without rebuilding the image. Validate that every advertised model in `nodes.yaml.supportedModels` is either in the env-supplied map or in the default map; fail-closed startup on an unmapped model.
- Resolved: _(open)_

### transcriptions-upload-buffering

- Opened: 2026-04-25
- Severity: low
- Area: runtime/http/audio
- Description: `/v1/audio/transcriptions` handler buffers the entire customer upload (up to 25 MiB) in memory before re-encoding the outbound multipart body. The plan called for end-to-end streaming via `Readable.toWeb(...)` so the file never materializes in bridge memory. Re-encoding was the simpler v1 implementation; impact is bounded by the 25 MiB cap and the per-request paid-route concurrency limit.
- Remediation: switch to a streaming pass-through that preserves the inbound `Content-Type` (boundary intact) and wraps `req.parts()` into a `ReadableStream` for the outbound fetch body. Avoids the buffer and improves time-to-first-byte on the worker.
- Resolved: _(open)_

### bridge-session-cache-misses-recipient-rand-hash

- Opened: 2026-04-25
- Severity: medium
- Area: src/service/payments/sessions.ts
- Description: `SessionCache` keys cached sessions by `(nodeId, recipient, ticketParams.expirationBlock)` (see `keyToString`). It does **not** include `recipientRandHash`. If the worker's payment daemon restarts (new in-memory HMAC `secret` → new `recipientRandHash` for every freshly-issued ticket-params) but the bridge's cached `expirationBlock` happens to land in an overlap window with the new daemon's quotes, the bridge would reuse a stale `workId` whose underlying `recipientRand` the daemon can no longer derive. ProcessPayment then 402s with `validator: invalid recipientRand for recipientRandHash`. Investigated during the first mainnet smoke deploy; turned out NOT to be the bug we hit (the actual bug was the missing `priceInfo` thread, fixed in `d76eb42` / library `b5190a9`), but the cache shape is fragile in exactly this way.
- Remediation: include `quote.ticketParams.recipientRandHash` in the cache key. Receiver-side, the right fix is persisting the secret across restarts (`receiver-secret-persistence` in the library tracker); bridge-side this entry is defense-in-depth for the case where the receiver is correctly rotated and we want the bridge to cache-miss cleanly. Update `SessionKey` + `keyToString` + tests; bumps no public surface.
- Resolved: _(open)_

### admin-issue-customer-key-endpoint

- Opened: 2026-04-25
- Severity: medium
- Area: src/runtime/http/admin, src/service/auth
- Description: `service/auth.issueKey` is the canonical primitive for minting an API key (HMAC over a generated suffix, INSERT into `api_keys`), and the test suites use it directly via the in-process service. There is **no** admin HTTP endpoint that exposes it — `src/runtime/http/admin/routes.ts` exposes refund / suspend / unsuspend / health / nodes / customers GET / escrow but no `POST /admin/customers/:id/issue-key` or `POST /admin/customers/issue-key`. In production, customers come into existence implicitly via Stripe checkout (the webhook handler creates rows), so the absence of an HTTP shape is invisible there. But for **operator-issued** keys — the very first admin key, smoke-test keys, manually-provisioned customer keys for partners — operators have to drop into SQL + `openssl` to reproduce the HMAC by hand. Documented as a workaround in `docs/operations/deployment.md "Issuing the first admin / smoke API key"`; see that recipe.
- Remediation: add `POST /admin/customers/:id/issue-key` (and optionally `POST /admin/customers/issue-key` that creates the customer + key in one call for the bootstrap flow) under the existing `adminAuthPreHandler`. Body: `{ envPrefix: 'test' | 'live' }`. Response: `{ apiKeyId, plaintext, prefix, last4 }` with the plaintext returned exactly once. Wire to `issueKey(db, ...)`. Test: TestPg + admin token round-trip + rejected without admin token. Update `docs/operations/deployment.md` to replace the SQL recipe with a `curl` recipe once landed.
- Resolved: _(open)_

### operator-economics-metrics-tooling

- Opened: 2026-04-25
- Severity: HIGH (load-bearing for the growth-phase pricing strategy)
- Area: src/runtime/http/admin, observability, tooling
- Description: The pricing strategy (cheap customer rates, low worker pay during growth phase, adjust upward as data warrants) DEPENDS on operators being able to see their actual economics. The bridge already records all the raw inputs (`usage_record`, `topup`, `node_health_event` tables; daemon BoltDB; on-chain redemption events) but does not surface them as operator-facing rollups. Today operators have to write SQL by hand or tail container logs to figure out: what's our customer revenue today, what EV did we ship to which workers, what's our gross margin per tier, are we actually keeping a worker fleet busy. Without this loop, no operator (worker or bridge) can decide when growth-phase rates can be moved — the whole adjustment process documented in `pricing-model.md` "Measurement and adjustment" is theoretical.
- Remediation: ship in roughly this order of value:
  1. `GET /admin/metrics/daily` — last-N-days rollup: customer revenue (USD cents), worker EV paid (wei + USD est at current ETH price), per-tier request count, per-tier net margin. JSON shape mirrors the existing admin endpoints.
  2. `GET /admin/metrics/per-worker` — per-`node_id` breakdown: tokens served, EV paid, % utilization (requests / max_concurrent_requests \* 100), circuit state.
  3. `GET /admin/metrics/per-tier` — per-tier rollup including realized $/M tokens (from `usage_record.cost_usd_cents` aggregated).
  4. ~~Worker daemon `/metrics` Prometheus endpoint: counters for `tickets_accepted_total`, `tickets_won_total`, `redemptions_succeeded_total`, `redemptions_failed_total`, `ev_earned_wei_total`, with `sender` label.~~ Closed 2026-04-25 by Pass-B metrics activation: the bridge itself now exposes a Prometheus `/metrics` endpoint via `METRICS_LISTEN` (recorder defined in `src/providers/metrics/recorder.ts`, exposition wiring in `src/runtime/metrics/server.ts`, sampler in `src/service/metrics/sampler.ts`). The bridge surfaces equivalent shape under the `livepeer_bridge_*` namespace (`requests_total`, `node_requests_total`, `node_cost_wei_total`, `payer_daemon_calls_total`, `payer_daemon_deposit_wei`, etc.). The original "worker daemon" framing is now subsumed: operators read the bridge's view rather than instrumenting the daemon a second time. Items 1–3 + 5–7 below remain open as Phase 3.
  5. CLI tool `livepeer-payment-stats --since=7d` that reads the daemon BoltDB + on-chain redemption events and prints a markdown report (realized $/M tokens, break-even projection, suggested `price_per_work_unit_wei` adjustment).
  6. Cost-attribution view: per-request join across `usage_record` + ticket batch ID + on-chain redemption tx hash, accessible as `GET /admin/metrics/request/:work_id`.
  7. Static HTML dashboard (auto-regenerated nightly): customer revenue vs worker EV vs (operator-input) infra cost over time, per tier.
- Resolved: _(open)_

### pricing-rebalance-pricing-model-doc-v1-tables

- Opened: 2026-04-25
- Severity: low
- Area: docs / pricing
- Description: Audit hook attached to the v2 rate-card rebalance (`2c40cbb`). All v1 numbers in `docs/design-docs/pricing-model.md` were replaced with v2 numbers + competitor comparison columns on 2026-04-25 (see "Competitive positioning" + the five "v2, effective 2026-04-25" tables); the matching `pricing.ts` constants were renamed in spirit (the JS const names still read `V1_*` for internal stability — renaming them to `V2_*` is a follow-up scrub). If you find any v1 numbers in design docs (e.g. `$0.20 / $0.60` for starter, `$0.025` for `text-embedding-3-small`, `$18.00` for `tts-1`, `$0.0072` for `whisper-1`), list them in this entry and re-do the sweep.
- Remediation: at next pricing change, re-grep design docs for stale numbers before publishing. Optional polish: rename the `V1_*` consts in `pricing.ts` to `V2_*` to match the rate-card version string.
- Resolved: _(open)_

### tokens-drift-unprefixed-names-removal

- Opened: 2026-04-25
- Severity: low
- Area: observability / tokenAudit
- Description: `src/service/tokenAudit/index.ts::emitDrift` currently emits BOTH the legacy unprefixed `MetricsSink` names (`tokens_drift_percent`, `tokens_local_count`, `tokens_reported_count` via `metrics.histogram` / `metrics.gauge`) AND the new prefixed `Recorder` calls (`observeTokenDriftPercent`, `addTokenCountLocal`, `addTokenCountReported`, which surface as `livepeer_bridge_token_*` in Prometheus). Both surfaces are intentional during Pass B's reconciliation window — Grafana panels still keyed off the legacy names need a migration grace period before the unprefixed emissions go away. Tracked separately so the cleanup commit is greppable.
- Remediation: Phase 2 of the metrics rollout. (1) Delete `emitOne(deps.metrics, ...)` and the `MetricsSink` dependency from `tokenAudit`. (2) Drop `LegacySink` + `MetricsSink` from `src/providers/metrics/*` and the `counter`/`gauge`/`histogram` shims on the recorder impls. (3) Update Grafana panels to the prefixed names. (4) Remove this entry.
- Resolved: _(open)_

### admin-audit-event-retention

- Opened: 2026-04-26
- Severity: low
- Area: repo / admin
- Description: `admin_audit_event` grows unbounded. With the operator console (0023) actively exposing the table via `GET /admin/audit`, the row count will accumulate proportional to operator activity. At soft-launch volumes (a handful of operators × tens of actions/day) the table stays small for years; at scale, query latency on the audit feed and the cost of full scans for actor/action filters grow without a partition strategy.
- Remediation: monthly partitioning (`PARTITION BY RANGE (occurred_at)`) plus an archive/drop policy for partitions older than N months. Defer until row count crosses ~1M or the audit-feed query latency shows up in alerts.
- Resolved: _(open)_

### admin-customer-search-trigram-index

- Opened: 2026-04-26
- Severity: low
- Area: repo / admin
- Description: `customersRepo.search` powers `GET /admin/customers?q=...` (and the operator console's customer search). Implementation is `ILIKE '%q%'` against `customers.email`, which forces a full scan; OK to ~100k customers, problematic past that. Documented inline in the query function as well.
- Remediation: install `pg_trgm` extension, add a GIN trigram index on `customers.email`, switch the query to `email %% q` with the threshold tuned. Revisit when `customers` row count crosses 50k or when operators report search latency.
- Resolved: _(open)_

### bridge-portal-console-session-token

- Opened: 2026-04-26
- Severity: low
- Area: frontend / auth
- Description: The customer portal (0022) auths by having the user paste their bridge API key, which is then stored in `sessionStorage` and sent as `Authorization: Bearer` on every request. Pragmatic for v1 (no new auth protocol, no email-link sender, no session table) but the credential held in storage IS the live API key (full account scope). The portal's strict CSP mitigates the XSS angle. Long-term, a short-lived console session token issued after a one-time API-key validation gives narrower exposure.
- Remediation: backend issues a `POST /v1/portal/session` endpoint that takes an API key and returns a 24h JWT scoped to the customer. Portal stores the JWT in sessionStorage, refreshes on activity. Don't pursue until the v1 model causes a real incident or compliance ask.
- Resolved: _(open)_

### frontend-shared-zod-codegen

- Opened: 2026-04-26
- Severity: low
- Area: frontend / types
- Description: The portal and admin UIs ship hand-mirrored runtime validators (`frontend/portal/lib/schemas.js`, `frontend/admin/lib/schemas.js`) that mirror server-side Zod schemas in `src/types/` + `src/runtime/http/*/routes.ts` field-by-field. The `npm run doc-lint` rule catches consumer/lib redefinition of shared/lib filenames, but does not diff schema _fields_ — drift between server Zod and client validators is silent until a type-mismatch surfaces in a request. Codegen UI validators from the server schemas would close that gap.
- Remediation: pick a codegen path (zod-to-json-schema → zod-from-json-schema in JS, or a custom emitter that walks the Zod object tree). Wire into `npm run build:ui` so client validators regenerate on each build. Defer until the first drift incident or when the route count grows past ~20.
- Resolved: _(open)_

### ~~pre-existing-doc-lint-violations~~

- Opened: 2026-04-26
- Severity: low
- Area: docs / lint
- Description: `npm run doc-lint` reported 11 pre-existing violations — none introduced by 0022/0023, but they predated the doc-gardener extension and never got cleaned up. Breakdown: 4 completed plans (0018, 0019, 0020, 0021) missing the `closed: YYYY-MM-DD` frontmatter field; 5 `design-doc-links-into-plans` violations in `docs/design-docs/metrics.md`; 2 cross-repo broken links in 0021 to `livepeer-payment-library` and `openai-worker-node` exec-plans.
- Remediation: see Resolved.
- Resolved: 2026-04-26 — fixed in one pass.
  1. `closed: 2026-04-25` backfilled into 0018/0019/0020/0021 (the date each was archived per `git log`).
  2. `metrics.md`'s three markdown links into `exec-plans/completed/0011-local-tokenizer-metric.md` flattened to text-only references; the two links into `tech-debt-tracker.md` now pass thanks to a doc-gardener whitelist (it lives under `exec-plans/` for organization but acts as a durable append-only registry, not a transient plan).
  3. Cross-repo markdown links in 0021 / 0022 / 0023 (six total) stripped to text-only references. Established the convention "no cross-repo markdown links in this repo's docs" — sibling-repo paths stay as backticked path text so readers can still locate them, but doc-lint no longer chases broken paths to repos that may not be colocated.
  4. Drive-by fix to doc-gardener's `plan-closed-before-opened` check, which was string-comparing JS Date `toString()` output (alphabetical, not chronological — `Fri Apr 24` < `Thu Apr 23` because `F` < `T`). Now compares via `.getTime()`.
  5. `npm run doc-lint` now passes clean.

## 0030 — operator-managed rate card — follow-ups (opened 2026-04-28)

### 0031-portal-pricing-page

- Opened: 2026-04-28
- Severity: low
- Area: frontend / portal
- Description: The customer portal (`/portal/`) doesn't expose a "here is what you pay per model" page. Customers learn pricing by sending a request and observing the cost in the response. A read-only pricing page reading the operator-managed rate card would reduce support load and help conversion ("compare to OpenAI list price").
- Remediation: dedicated exec-plan `0031-portal-pricing-page.md` when picked up. UI piggybacks on `GET /admin/pricing/*` (read-only — no auth needed for a public pricing page; expose a public mirror endpoint or have the bridge serve the data unauthenticated).
- Resolved: _(open)_

### 0032-margin-dashboard

- Opened: 2026-04-28
- Severity: medium
- Area: frontend / admin / pricing
- Description: Operators don't have visibility into per-model margin. They charge customers via the rate card (in USD) and pay workers in wei via the registry overlay's `price_per_work_unit_wei`. Computing margin requires an ETH/USD oracle to convert wei → USD.
- Remediation: dedicated exec-plan `0032-margin-dashboard.md`. Six design questions captured in chat 2026-04-28 (ETH oracle source, worker-cost source, SPA placement, snapshot vs time-series, capability scope, refresh cadence). On hold per operator decision.
- Resolved: _(open)_

### 0033-per-customer-rate-card-overrides

- Opened: 2026-04-28
- Severity: low
- Area: pricing / billing
- Description: All customers currently share one rate card. Some operators want to give specific customers different prices (custom-fine-tune model unlocks, enterprise volume discounts, free-trial promo codes). Currently impossible without a fork.
- Remediation: dedicated exec-plan `0033-per-customer-rate-card-overrides.md` when picked up. Likely shape: `app.customer_rate_card_overrides (customer_id, model_or_pattern, tier, …)` table, resolution order in dispatch becomes per-customer-overrides → tenant rate card → null.
- Resolved: _(open)_

### operator-addable-tier-names

- Opened: 2026-04-28
- Severity: low
- Area: engine / pricing
- Description: Tier names (`starter`, `standard`, `pro`, `premium`) are fixed in the engine. Operators can edit tier _prices_ (0030) but not add new tier names. Some operators may want a fifth tier ("enterprise", "white-label") for bespoke pricing. Today this requires an engine release.
- Remediation: replace the `PricingTier` zod enum with a string ref + add `tier` rows in `app.rate_card_chat_tiers` to be the source of truth for what tiers exist. Schema migration + foreign-key cascade. Customer.tier and rate-limit-tier columns currently reference the enum — switch them to text + soft validation.
- Resolved: _(open)_

### asNumber-helper-cleanup

- Opened: 2026-04-28
- Severity: low
- Area: code / pricing
- Description: `runtime/http/admin/pricing.ts` has an `async function asNumber(v): Promise<string>` helper that's not actually async — it just returns `String(v)`. Leftover from refactor. Inline the conversion at call sites or make it a sync utility.
- Remediation: 1-line cleanup; no behavior change. Drop the `await` calls in the route handlers too.
- Resolved: _(open)_

### admin-routes-file-size-warning

- Opened: 2026-04-28
- Severity: low
- Area: code / admin
- Description: `runtime/http/admin/routes.ts` is 560 lines, over the 400-line soft cap. ESLint warns. The handlers split naturally by resource (customers, nodes, escrow, audit, reservations, topups, registry-probe).
- Remediation: split into `runtime/http/admin/routes/{customers,nodes,escrow,audit,reservations,topups,registry}.ts` + a top-level `register()` that calls each. ~30 minutes of mechanical refactor.
- Resolved: _(open)_

### admin-routes-branches-test-flake

- Opened: 2026-04-28
- Severity: low
- Area: tests / infra
- Description: `runtime/http/admin/admin-routes-branches.test.ts > GET /admin/audit accepts valid from/to and applies them` fails ~10 % of the time when the full test suite runs in parallel — the testcontainer Postgres pool contends. The test passes 100 % in isolation. Flake, not a bug in the code under test.
- Remediation: switch the affected admin tests to `describe.sequential` or annotate the file's tests as `serial`. Or migrate to a per-test schema via `SET search_path` rather than shared TRUNCATE.
- Resolved: _(open)_
