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

### layer-check ESLint plugin — stub only

- Opened: 2026-04-24
- Severity: medium
- Area: lint
- Description: `lint/layer-check/index.mjs` is currently a warn-and-exit-0 stub. The dependency rule from `docs/design-docs/architecture.md` (types → config → repo → service → runtime → ui + providers) is not yet enforced mechanically — CI will pass on violations.
- Remediation: dedicated exec-plan to author an AST-based layer-check (and the companion `no-cross-cutting-import`, `zod-at-boundary`, `no-secrets-in-logs`, `file-size` rules described in `lint/README.md`).
- Resolved: _(open)_

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

### `src/types/` shape lint not enforced

- Opened: 2026-04-24
- Severity: low
- Area: lint / types
- Description: 0002-types-and-zod calls for a lint that asserts every file in `src/types/` exports both a Zod schema and the inferred `z.infer` type. Currently relying on code review. Convention is respected by every file authored in 0002.
- Remediation: add as a rule in the ESLint plugin work (see above).
- Resolved: _(open)_
