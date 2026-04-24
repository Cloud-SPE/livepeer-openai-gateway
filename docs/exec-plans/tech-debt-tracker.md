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

### `src/types/` shape lint not enforced

- Opened: 2026-04-24
- Severity: low
- Area: lint / types
- Description: 0002-types-and-zod calls for a lint that asserts every file in `src/types/` exports both a Zod schema and the inferred `z.infer` type. Currently relying on code review. Convention is respected by every file authored in 0002.
- Remediation: add as a rule in the ESLint plugin work (see above).
- Resolved: _(open)_
