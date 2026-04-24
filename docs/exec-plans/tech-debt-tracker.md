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

