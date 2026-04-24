# lint/

Custom lints that enforce architectural invariants beyond what ESLint's built-in rules handle. Each lint:

- Lives in its own subdirectory.
- Is a Node.js script invokable via `node ./lint/<name>/index.mjs` (or as an ESLint custom rule plugin).
- Produces structured errors with **remediation instructions** embedded in the message.

## Planned lints

### layer-check

Enforces the dependency rule from `docs/design-docs/architecture.md`:

```
types → config → repo → service → runtime → ui
```

plus `providers/` accessible from all.

Detects violations like:

- `service/routing` importing `@grpc/grpc-js` directly (must go through `providers/payerDaemon`)
- `service/billing` importing `service/routing` (no cross-domain imports inside service)
- `repo/*` importing `service/*` (repo is below service)

Status: **stub**. Full implementation as an ESLint plugin tracked separately.

### no-cross-cutting-import

Companion to `layer-check`: explicit allowlist of external packages that are forbidden outside `providers/` (`stripe`, `ioredis`, `pg`, `@grpc/*`, `tiktoken`, `viem`, `pino`).

Status: **planned**.

### zod-at-boundary

Requires every HTTP handler and gRPC response handler to start with a Zod `.parse()` or `.safeParse()` before touching any other code. Structural check on the AST.

Status: **planned**.

### no-secrets-in-logs

Scans log call arguments for variables or literals matching `apiKey`, `stripeSecret`, `passphrase`, `privateKey`, `keystore`, etc.

Status: **planned**.

### file-size

Warns at 400 lines, errors at 600.

Status: **planned**.

## Format

Lint errors must include:

```
<file>:<line>: <rule-id>: <one-line problem>
  Remediation: <one-or-two sentence guidance>
  See: docs/design-docs/<relevant-doc>.md
```

This lets agents fix violations autonomously from the error message.
