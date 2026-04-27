# Governance

This project follows a lightweight maintainer-driven model. The goal
is to keep the door open for contributors while preserving the
adapter-contract stability that downstream operators depend on.

## Maintainers

- Mike Zupper ([@mazup](https://github.com/mazup)) — initial author,
  project lead.

Non-binding goal: at least two active maintainers within six months
of the first external production adopter.

## Decision-making

- **Day-to-day** (bug fixes, internal refactors, doc fixes,
  dependency bumps): maintainer rough consensus. Single approving
  review is sufficient.
- **Architectural changes** (adapter interface shape, engine schema,
  semver-affecting public API changes): exec-plan in
  `docs/exec-plans/active/`, two-business-day comment window before
  merge. Two approving reviews if more than one maintainer is active.
- **Breaking changes (pre-1.0)**: documented in `CHANGELOG.md` under
  the next minor release. No major version bump required while we
  remain on `0.x`.
- **Breaking changes (post-1.0)**: exec-plan required. Major version
  bump. Migration guide in the changelog.

## Scope of decisions

The maintainers decide on:

- The shape of the operator-overridable adapters
  (`Wallet`, `AuthResolver`, `RateLimiter`, `Logger`,
  `AdminAuthResolver`).
- The engine database schema (the `engine.*` namespace).
- The engine metric surface (the `livepeer_bridge_*` prefix).
- The Fastify adapter's exported route registers.
- Public API exports under `@cloudspe/livepeer-gateway-core/*`.

Operators are expected to make their own choices about:

- Their `Wallet` impl (postpaid B2B vs. prepaid USD vs. free-quota
  tokens vs. crypto).
- Their `AuthResolver` impl (bearer-token, mTLS, OAuth, custom).
- Their `RateLimiter` impl (Redis default works; Memcached / in-memory
  / external service all valid alternatives).
- Their `AdminAuthResolver` impl (basic-auth default works; SSO /
  SAML / mTLS-client-cert all valid alternatives).
- Their database deployment (Postgres is required, but pooled vs.
  direct, RDS vs. self-hosted vs. Supabase is operator-owned).

## Adding maintainers

Invite-only, by existing-maintainer consensus, after sustained
quality contributions. Contributions that count:

- Multiple non-trivial PRs merged over at least 60 days.
- Helpful triage on issues (asking for repros, linking duplicates,
  proposing concrete next steps).
- Clear writing — exec-plans, RFCs, doc improvements.
- Demonstrated understanding of the engine/shell boundary and the
  adapter-contract stability discipline.

There's no committee; the existing maintainer roster decides by
consensus and announces the addition in `CHANGELOG.md` under
`### Project`.

## Removing maintainers

A maintainer who has been inactive for 6 months without prior notice
may be moved to "emeritus" status by the remaining maintainers. They
keep credit but lose merge rights. They can rejoin by re-engaging
with the project.

A maintainer who violates the [Code of Conduct](CODE_OF_CONDUCT.md)
loses all roles immediately, with notice to the community.

## Forking

The MIT license permits forks for any reason. We ask (don't require)
that forks rename to avoid confusion with upstream releases — e.g. if
you maintain a private fork of `@cloudspe/livepeer-gateway-core`,
publish it under your own scope.

If you maintain an active public fork that diverges from upstream,
let us know in a GitHub issue tagged `fork` so we can link it from
the README for discoverability. We won't merge fork-specific patches
upstream unless they're applicable to all users.

## Project finances

This project has no commercial entity, no donations, no infrastructure
that costs money. The reference Postgres + Redis + payment-daemon +
service-registry-daemon stack runs on operator infrastructure.

If donations or sponsorship become relevant, governance updates
land in this file under `## Funding` before any money changes hands.
