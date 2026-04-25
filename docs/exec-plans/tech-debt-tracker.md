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
- Remediation: one workflow file once the registry is picked.
- Resolved: _(open)_

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

### pricing-rebalance-pricing-model-doc-v1-tables

- Opened: 2026-04-25
- Severity: low
- Area: docs / pricing
- Description: Audit hook attached to the v2 rate-card rebalance (`2c40cbb`). All v1 numbers in `docs/design-docs/pricing-model.md` were replaced with v2 numbers + competitor comparison columns on 2026-04-25 (see "Competitive positioning" + the five "v2, effective 2026-04-25" tables); the matching `pricing.ts` constants were renamed in spirit (the JS const names still read `V1_*` for internal stability — renaming them to `V2_*` is a follow-up scrub). If you find any v1 numbers in design docs (e.g. `$0.20 / $0.60` for starter, `$0.025` for `text-embedding-3-small`, `$18.00` for `tts-1`, `$0.0072` for `whisper-1`), list them in this entry and re-do the sweep.
- Remediation: at next pricing change, re-grep design docs for stale numbers before publishing. Optional polish: rename the `V1_*` consts in `pricing.ts` to `V2_*` to match the rate-card version string.
- Resolved: _(open)_
