# Design docs index

A catalog of every design-doc in this repo, with verification status and core beliefs.

## Verification status

Each doc carries a `status:` field in its frontmatter. Values:

| Status       | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| `proposed`   | Written, not yet reviewed or implemented                |
| `accepted`   | Reviewed, intended direction, not yet fully implemented |
| `verified`   | Implemented and matches code; covered by tests          |
| `deprecated` | Superseded or abandoned; kept for history               |

A doc-gardening lint in CI flags docs with stale status, broken cross-links, or no recent touch after linked code last changed.

## Core beliefs

Non-negotiables that shape every decision in this repo.

- [core-beliefs.md](core-beliefs.md) — `accepted`

## Architectural decisions

- [architecture.md](architecture.md) — `accepted` — layer stack, domains, providers
- `tiers.md` — _planned_ — Free vs Prepaid semantics, upgrade flow
- `pricing-model.md` — _planned_ — rate card tiers, margin calculation, adjustment policy
- `streaming-semantics.md` — _planned_ — pre-payment reservation, stream cancellation, partial success
- `token-audit.md` — _planned_ — LocalTokenizer phases (observe → audit → enforce)
- `retry-policy.md` — _planned_ — retry table and rationale
- `node-lifecycle.md` — _planned_ — NodeBook config, QuoteRefresher, health/circuit-break
- `escrow-operations.md` — _planned_ — reserve sizing, top-up, alerts
- `reconciliation.md` — _planned_ — three-ledger relationship (customer USD, daemon EV, on-chain)

## Conventions

- Every design-doc has frontmatter: `title`, `status`, `last-reviewed`, optional `supersedes` and `superseded-by`.
- Docs may link to other docs; they may not link into `exec-plans/` (plans are transient; docs are durable).
- When implementation diverges from a doc, either the code changes to match or the doc is updated — never both out of sync.
