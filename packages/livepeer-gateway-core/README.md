# `@cloudspe/livepeer-gateway-core`

OpenAI-compatible request engine fronting Livepeer worker pools.
Adapter-driven: bring your own billing, auth, rate-limit, logging,
and admin auth. Ships an optional Fastify route adapter and a
read-only operator dashboard.

```
┌─────────────────────────┐    ┌──────────────────────────────────────┐    ┌──────────────┐
│ OpenAI client (curl /   │ →  │  livepeer-gateway-core (this engine) │ →  │ WorkerNodes  │
│ openai-sdk / langchain) │    │  ─ auth → rate-limit → reserve →     │    │ (paid via    │
└─────────────────────────┘    │    select node → call → commit       │    │  payment-    │
                               │  ─ Fastify routes wire in            │    │  daemon)     │
                               │  ─ adapters: Wallet, AuthResolver,   │    └──────────────┘
                               │    RateLimiter, Logger,              │
                               │    AdminAuthResolver                 │
                               └──────────────────────────────────────┘
```

## Quickstart

The fastest path to a running gateway is the bundled minimal-shell
example. It uses `InMemoryWallet` + a no-op AuthResolver so there's
no DB or identity provider to wire up.

```sh
git clone https://github.com/Cloud-SPE/livepeer-gateway-core.git
cd livepeer-gateway-core
npm install
cd examples/minimal-shell
cp service-registry-config.example.yaml service-registry-config.yaml
cp payment-daemon-config.example.yaml payment-daemon-config.yaml
$EDITOR service-registry-config.yaml          # add your worker nodes
$EDITOR payment-daemon-config.yaml            # add your keystore + RPC
docker compose up
# In another shell:
curl -sS http://localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer demo' \
  -H 'content-type: application/json' \
  -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"hi"}]}'
```

Full walkthrough in [`examples/minimal-shell/README.md`](examples/minimal-shell/README.md).

## Adapters (you supply these)

The engine commits to five operator-overridable adapters. Pick the
ones that match your deployment; all five have working defaults
shipped with the engine.

| Adapter | Purpose | Default impl |
|---------|---------|--------------|
| `Wallet` | Billing/quota authority. Reserve before dispatch, commit on success, refund on failure. | `InMemoryWallet` (testing only) |
| `AuthResolver` | HTTP `Authorization` header → generic `Caller`. | none — wire your own |
| `RateLimiter` | Per-caller request gating (sliding window + concurrency). | Redis sliding-window |
| `Logger` | Structured log sink. | `createConsoleLogger` |
| `AdminAuthResolver` | Admin-token / basic-auth backing for the optional operator dashboard. | `createBasicAdminAuthResolver` |

Long-form: [`docs/adapters.md`](docs/adapters.md). Three runnable
Wallet stubs (postpaid B2B / prepaid USD / free-quota tokens) live
in [`examples/wallets/`](examples/wallets/).

## Ecosystem integration

The engine **requires two sidecar daemons** to run:

- **`livepeer-payment-daemon`** (sender mode) — creates probabilistic
  micropayment tickets to compensate worker nodes. Repo:
  [`livepeer-modules-project/livepeer-payment-library`](https://github.com/livepeer-modules-project/livepeer-payment-library).
  Talks to the engine over a unix socket; the engine pins this
  daemon's gRPC contract.
- **`livepeer-service-registry-daemon`** (resolver mode) — answers
  `Select` / `ListKnown` / `ResolveByAddress` for the WorkerNode
  pool. Repo:
  [`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon).
  Same socket-based contract.

The engine **does not** support a static-YAML node-pool fallback —
running without the registry-daemon is unsupported. Both daemons
are MIT-licensed.

The minimal-shell example's `compose.yaml` brings up both daemons
alongside the gateway process.

`livepeer-modules-project/protocol-daemon` is **orthogonal** —
orchestrator-side concern, not needed by gateway operators unless
they also run an orchestrator.

Cross-ecosystem metric naming + port allocation conventions live at
[`livepeer-modules-project/livepeer-modules-conventions`](https://github.com/livepeer-modules-project/livepeer-modules-conventions).

## Reference shell implementation

[`Cloud-SPE/livepeer-openai-gateway`](https://github.com/Cloud-SPE/livepeer-openai-gateway)
is a production-ready shell that wires `@cloudspe/livepeer-gateway-core`
with prepaid USD billing (Postgres + Stripe top-ups), API-key auth,
Redis-backed rate limiting, and admin + customer-portal SPAs. Read
it as a worked example of how the adapter contracts compose under
load.

## Versioning

**Pre-1.0 (`0.x`)**: breaking changes may land in any minor release.
Every breaking change is documented in [`CHANGELOG.md`](CHANGELOG.md).
Pin to a `^0.1.0`-style range and bump explicitly — don't
auto-update.

**Post-1.0**: strict [SemVer](https://semver.org/). 1.0 ships when
the first external operator successfully runs in production on this
engine and signs off on the adapter contracts.

## Documentation map

- [`docs/architecture.md`](docs/architecture.md) — engine internals:
  layer stack, dispatcher pipeline, payment-daemon integration.
- [`docs/adapters.md`](docs/adapters.md) — long-form adapter guide
  with patterns for each of the five operator-overridable adapters.
- [`docs/design-docs/`](docs/design-docs/) — focused design notes
  (node lifecycle, payer integration, pricing model, streaming
  semantics, token audit, retry policy, metrics, operator dashboard).
- [`AGENTS.md`](AGENTS.md) — agent-first contributor guide.
- [`DESIGN.md`](DESIGN.md) — what the engine is + isn't.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, test rules,
  commit + PR conventions, the adapter-contract change ladder.
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting flow.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.
- [`GOVERNANCE.md`](GOVERNANCE.md) — maintainers + decision rules.

## License

[MIT](LICENSE) — Cloud-SPE contributors.
