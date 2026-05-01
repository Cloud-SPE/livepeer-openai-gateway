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
- [payer-integration.md](payer-integration.md) — `accepted` — current shipped payer client path vs upstream v3 sender contract, error mapping, fail-closed semantics
- [streaming-semantics.md](streaming-semantics.md) — `accepted` — SSE forwarding, include_usage injection/stripping, disconnect and partial-success
- [retry-policy.md](retry-policy.md) — `accepted` — retry table for node dispatch (pre-first-token only)
- [stripe-integration.md](stripe-integration.md) — `accepted` — Checkout top-ups, webhook flow, idempotency, tier upgrade
- [token-audit.md](token-audit.md) — `accepted` — LocalTokenizer phases (observe → audit → enforce), drift metric, integration points
- [metrics.md](metrics.md) — `accepted` — Prometheus metrics catalog (Phase 1 wires `prom-client` Recorder + `/metrics` endpoint; mirrors service-registry's verified pattern; cross-repo reconciliation panels enabled by consistent labels; advances `operator-economics-metrics-tooling`)
- [ui-architecture.md](ui-architecture.md) — `accepted` — `frontend/` Lit + RxJS + modern-CSS UI modules, `shared/` directory module pattern, light DOM, hash routing, sessionStorage credentials
- [operator-dashboard.md](operator-dashboard.md) — `accepted` — engine's optional read-only operator dashboard (`@cloudspe/livepeer-openai-gateway-core/dashboard`), vanilla TS, basic-auth, distinct from the shell's admin SPA
- [v3-runtime-realignment.md](v3-runtime-realignment.md) — `accepted` — explicit boundary between the shell's current shipped runtime and the suite's newer v3.0.1 protocol cut
- `escrow-operations.md` — _planned_ — reserve sizing, top-up, alerts
- `reconciliation.md` — _planned_ — three-ledger relationship (customer USD, daemon EV, on-chain)

Cross-repo:

- [`https://github.com/Cloud-SPE/livepeer-modules/blob/main/docs/conventions/metrics.md`](https://github.com/Cloud-SPE/livepeer-modules/blob/main/docs/conventions/metrics.md) — authoritative naming, label, bucket, cardinality, and provider-boundary rules shared across all repos in the fleet
- [`https://github.com/Cloud-SPE/livepeer-modules/blob/main/service-registry-daemon/docs/design-docs/observability.md`](https://github.com/Cloud-SPE/livepeer-modules/blob/main/service-registry-daemon/docs/design-docs/observability.md) — reference implementation of the Recorder pattern this repo's metrics.md mirrors
- [`https://github.com/Cloud-SPE/livepeer-modules/tree/main/service-registry-daemon`](https://github.com/Cloud-SPE/livepeer-modules/tree/main/service-registry-daemon) — canonical home of the resolver/publisher daemon the bridge consumes over unix socket
- [`https://github.com/Cloud-SPE/livepeer-modules/blob/main/payment-daemon/docs/design-docs/wire-compat.md`](https://github.com/Cloud-SPE/livepeer-modules/blob/main/payment-daemon/docs/design-docs/wire-compat.md) — pm-ticket signature wire-compat (EIP-191 + v ∈ {27,28}); the bridge's payment-daemon must match this format for any worker to validate its tickets

## Conventions

- Every design-doc has frontmatter: `title`, `status`, `last-reviewed`, optional `supersedes` and `superseded-by`.
- Docs may link to other docs; they may not link into `exec-plans/` (plans are transient; docs are durable).
- When implementation diverges from a doc, either the code changes to match or the doc is updated — never both out of sync.
