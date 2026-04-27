## Summary

<1–3 sentences describing the change.>

## Linked exec-plan

<`docs/exec-plans/active/00XX-*.md`, or "ephemeral" for trivial changes.>

## Test plan

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated (TestPg, real Fastify, real
      gRPC where applicable — no DB mocks)
- [ ] Coverage stays ≥ 75% on all v8 metrics
- [ ] CHANGELOG entry added under `## [Unreleased]`

## Adapter contracts

- [ ] No change to public adapter interfaces (`Wallet`, `AuthResolver`,
      `RateLimiter`, `Logger`, `AdminAuthResolver`)
- [ ] Schema unchanged (no migration required)
- [ ] Public export paths unchanged (`@cloudspe/livepeer-gateway-core/*`)

If any of the above are checked off because the PR *does* change them,
flag the version-bump intent below.

## Breaking changes

<None, or describe + flag the version bump required (minor pre-1.0,
major post-1.0).>

## Sign-off

By submitting, I agree to the [DCO](https://developercertificate.org/) —
my commit messages include `Signed-off-by:` lines (run
`git commit -s` if you're not already configured).
