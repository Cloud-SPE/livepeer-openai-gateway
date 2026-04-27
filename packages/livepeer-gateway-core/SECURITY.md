# Security policy

## Supported versions

Pre-1.0: we backport security fixes to the latest minor release in the
current `0.x` series.

Post-1.0: we maintain the latest two minor versions.

## Reporting a vulnerability

Email **<security@livepeer.cloud>**.

**Do NOT open a public GitHub issue** for security reports — the
distribution of impact + the time-to-patch window matters here.

We acknowledge within **48 hours** and aim to ship a patched release
within **14 days** for critical or high-severity issues. Lower-severity
issues are batched into the next minor release.

## Disclosure

Coordinated disclosure. Reporters are credited in `CHANGELOG.md` if
they wish; opt-out is the default to make reporting frictionless.

## Scope

In scope:

- Authentication / authorization bugs in the adapter interfaces or
  the default impls (`createPrepaidQuotaWallet`, `createAuthResolver`,
  `createBasicAdminAuthResolver`).
- Payment-daemon integration vulnerabilities — ticket signing,
  payment-blob handling, deposit-info exposure.
- Pricing / billing math errors that could be exploited (overflow,
  rounding direction, race conditions on the reservation lifecycle).
- Dependency advisories that affect the engine — we ship `npm audit`
  output in CI and treat critical advisories as security issues.
- Cardinality-cap bypasses or label-injection paths in the metrics
  recorder.

Out of scope:

- The operator's own `Wallet` / `AuthResolver` / `RateLimiter` /
  `Logger` / `AdminAuthResolver` impl — those are the operator's
  code and security boundary.
- Mock-mode / test-only paths (`InMemoryWallet`, fixtures under
  `examples/wallets/`).
- Configuration mistakes that don't reveal a vulnerability (e.g.
  exposing the engine on the public internet without an auth
  resolver — that's an operator config bug, not an engine bug).
- Issues in the `service-registry-daemon` or `payment-daemon` — file
  those against
  [`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon)
  and the [livepeer-payment-library](https://github.com/livepeer-modules-project/livepeer-payment-library)
  respectively.
