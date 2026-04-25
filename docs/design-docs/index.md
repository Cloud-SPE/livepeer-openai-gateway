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

- [architecture.md](architecture.md) — `accepted` — layer stack, domains, providers (refreshed for 0017/0018/0020)
- [tiers.md](tiers.md) — `accepted` — Free vs Prepaid semantics, reserve/commit/refund, upgrade flow
- [pricing-model.md](pricing-model.md) — `accepted` — rate card tiers, margin calculation, adjustment policy (covers chat tier-based + embeddings/images model-keyed; audio rate cards land with 0019)
- [node-lifecycle.md](node-lifecycle.md) — `accepted` — NodeBook config, QuoteRefresher, per-capability quote storage, health/circuit-break, reload semantics
- [payer-integration.md](payer-integration.md) — `accepted` — PayerDaemon gRPC client, session lifecycle, error mapping, fail-closed semantics
- [streaming-semantics.md](streaming-semantics.md) — `accepted` — SSE forwarding, include_usage injection/stripping, disconnect and partial-success
- [retry-policy.md](retry-policy.md) — `accepted` — retry table for node dispatch (pre-first-token only)
- [stripe-integration.md](stripe-integration.md) — `accepted` — Checkout top-ups, webhook flow, idempotency, tier upgrade
- [token-audit.md](token-audit.md) — `accepted` — LocalTokenizer phases (observe → audit → enforce), drift metric, integration points
- `escrow-operations.md` — _planned_ — reserve sizing, top-up, alerts
- `reconciliation.md` — _planned_ — three-ledger relationship (customer USD, daemon EV, on-chain)

Cross-repo:

- [`../../../livepeer-payment-library/docs/design-docs/shared-yaml.md`](../../../livepeer-payment-library/docs/design-docs/shared-yaml.md) — the `worker.yaml` cross-repo contract the bridge consumes via `nodes.yaml` per-node references and via the worker's `/capabilities` advertisement.

## Conventions

- Every design-doc has frontmatter: `title`, `status`, `last-reviewed`, optional `supersedes` and `superseded-by`.
- Docs may link to other docs; they may not link into `exec-plans/` (plans are transient; docs are durable).
- When implementation diverges from a doc, either the code changes to match or the doc is updated — never both out of sync.
