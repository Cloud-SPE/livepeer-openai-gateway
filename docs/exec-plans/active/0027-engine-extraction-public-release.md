---
id: 0027
slug: engine-extraction-public-release
title: Engine extraction stage 4 — bootstrap public Cloud-SPE/livepeer-bridge-core repo; sync packages/bridge-core/ over; ship examples/minimal-shell; CI/npm publish under @cloud-spe/bridge-core (placeholder); cut 0.1.0; this repo swaps workspace dep for npm dep
status: active
owner: agent
opened: 2026-04-26
---

## Goal

Stage 4 of a 4-stage extraction. With the engine isolated as a workspace package from [`0026`](../completed/0026-engine-extraction-workspace.md), this stage bootstraps the public OSS repo `Cloud-SPE/livepeer-bridge-core` on GitHub, syncs the engine package over, sets up CI to build/test/publish-on-tag, ships a runnable `examples/minimal-shell/` (using `InMemoryWallet` + a no-op `AuthResolver`) so adopters can clone-and-run in 30 seconds, cuts version `0.1.0`, and rewires this repo to consume the engine via npm dep instead of the workspace symlink.

After this stage:
- Public GitHub repo `Cloud-SPE/livepeer-bridge-core` exists, MIT-licensed, with the engine source.
- Engine published to npm as `@cloud-spe/bridge-core@0.1.0` (placeholder scope; the published name may move to `@livepeer/*` or another org before public announcement — the placeholder is documented and swappable in one PR).
- Public repo has CI: build matrix (Node 20, 22), `npm test`, `npm run lint`, `npm run typecheck`, publish-on-tag-with-`v*`-prefix.
- `examples/minimal-shell/` is a 200-LOC runnable Fastify app using engine's `dispatchChatCompletion` + `InMemoryWallet` + a `NoopAuthResolver`. README walks through `npm install` → `node start.js` → `curl /v1/chat/completions`.
- This repo's `packages/livepeer-openai-gateway/package.json` swaps `"@cloud-spe/bridge-core": "workspace:*"` → `"@cloud-spe/bridge-core": "^0.1.0"`.
- This repo's `packages/bridge-core/` is removed (now lives in the public repo).
- This repo's CI no longer builds the engine — it only consumes the npm package.

Pre-1.0 versioning rule (per stage-0 agreement): breaking changes are OK at 0.x; patch bumps may include API breaks until 1.0. 1.0 is cut on first external operator adopter.

## Non-goals

- No transferring of git history from this repo to the public repo. The public repo starts with a clean initial commit. (If full history transfer is desired later, that's a follow-up — not blocking the release.)
- No automated mirror tooling. After this stage, engine changes go directly to the public repo; this repo consumes via npm.
- No promotion to 1.0. 1.0 cut is event-driven (first external adopter).
- No swap to a different npm scope/name yet. `@cloud-spe/bridge-core` is the published placeholder; renaming to `@livepeer/*` or similar is a follow-up that updates the engine repo's `name` field, deprecates the old, publishes under the new.
- No example wallet impls beyond `InMemoryWallet` + a postpaid stub in `examples/`. Operator-specific patterns (crypto wallets, etc.) are documented in the README, not shipped.
- No GitHub Discussions/Wiki setup. Issue + PR templates only (covered by [`0028-oss-readiness.md`](./0028-oss-readiness.md)).
- No engine schema or interface changes — purely a release/distribution stage.

## Approach

### 1. Bootstrap public repo

Manual ops step (gh CLI):

```bash
gh repo create Cloud-SPE/livepeer-bridge-core --public --description "OpenAI-compatible request engine for Livepeer worker pools. Adapter-driven; bring your own billing, auth, rate-limit. MIT."
```

Local clone bootstrapped via:

```bash
git clone git@github.com:Cloud-SPE/livepeer-bridge-core.git
cd livepeer-bridge-core
# Copy contents of packages/bridge-core/* from this repo
# git add -A; git commit -m "initial: extract from openai-livepeer-bridge@<sha>"
```

Initial commit message references the source SHA so future archeology is possible.

### 2. Public repo layout

```
livepeer-bridge-core/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml              # build, test, lint, typecheck on push + PR
│   │   └── publish.yml         # publish to npm on tag v*
│   ├── ISSUE_TEMPLATE/         # filled in by 0028
│   └── PULL_REQUEST_TEMPLATE.md
├── docs/
│   ├── architecture.md         # engine architecture (carved from this repo's design-docs)
│   ├── adapters.md             # Wallet/AuthResolver/RateLimiter/Logger/AdminAuthResolver guide
│   ├── examples.md             # minimal-shell walkthrough + adapter patterns
│   └── design-docs/            # engine-only subset (node-lifecycle, payer-integration, pricing-model, streaming-semantics, token-audit, retry-policy)
├── examples/
│   └── minimal-shell/
│       ├── package.json
│       ├── start.ts            # ~150 LOC: imports @cloud-spe/bridge-core, wires InMemoryWallet + NoopAuthResolver, registers Fastify routes
│       ├── nodes.example.yaml
│       └── README.md
├── migrations/                 # engine schema only
├── src/                        # engine source (was packages/bridge-core/src/)
├── tests/
├── AGENTS.md                   # engine-scoped agent guide (carved from this repo's AGENTS.md)
├── DESIGN.md                   # engine design (carved)
├── PLANS.md                    # carved
├── README.md                   # primary public-facing entry point
├── CHANGELOG.md                # 0028
├── CONTRIBUTING.md             # 0028
├── CODE_OF_CONDUCT.md          # 0028
├── SECURITY.md                 # 0028
├── GOVERNANCE.md               # 0028
├── LICENSE                     # MIT, per stage-0
├── package.json                # name: @cloud-spe/bridge-core, version: 0.1.0
├── tsconfig.json
├── vitest.config.ts
└── eslint.config.js
```

### 3. `examples/minimal-shell/`

A runnable bare-bones operator that proves the engine is usable without any of the shell's machinery. **Requires two daemons** alongside the example: `livepeer-payment-daemon` (sender mode) and `livepeer-service-registry-daemon`. The example ships a `compose.yaml` that brings up both alongside the minimal-shell process.

```ts
// examples/minimal-shell/start.ts
import Fastify from 'fastify';
import {
  InMemoryWallet,
  createNoopAuthResolver,
  createCircuitBreaker,
  createQuoteCache,
  createQuoteRefresher,
  createFetchNodeClient,
  createGrpcPayerDaemonClient,
  createGrpcServiceRegistryClient,
  createPaymentsService,
  createSessionCache,
  realScheduler,
  NoopRecorder,
  loadPayerDaemonConfig,
  loadServiceRegistryConfig,
  loadPricingConfig,
} from '@cloud-spe/bridge-core';
import { registerChatCompletionsRoute } from '@cloud-spe/bridge-core/fastify';

const wallet = new InMemoryWallet();
const authResolver = createNoopAuthResolver({ defaultTier: 'free' });
const nodeClient = createFetchNodeClient();
const payerDaemonConfig = loadPayerDaemonConfig();
const payerDaemon = createGrpcPayerDaemonClient({ config: payerDaemonConfig, scheduler: realScheduler() });
const sessionCache = createSessionCache({ payerDaemon });
const paymentsService = createPaymentsService({ payerDaemon, sessions: sessionCache });
const serviceRegistry = createGrpcServiceRegistryClient({ config: loadServiceRegistryConfig(), scheduler: realScheduler() });
const circuitBreaker = createCircuitBreaker();
const quoteCache = createQuoteCache();
const pricing = loadPricingConfig();

createQuoteRefresher({ serviceRegistry, nodeClient, quoteCache, scheduler: realScheduler(), bridgeEthAddress: payerDaemonConfig.bridgeEthAddress, recorder: new NoopRecorder() }).start();

const app = Fastify();
registerChatCompletionsRoute(app, { wallet, authResolver, serviceRegistry, circuitBreaker, quoteCache, nodeClient, paymentsService, pricing });
await app.listen({ port: 8080 });
console.log('Minimal shell running on :8080');
```

`examples/minimal-shell/compose.yaml` brings up:
- `service-registry-daemon` (config: `./service-registry-config.yaml`) on socket `/var/run/livepeer/service-registry.sock`
- `payment-daemon` (sender mode, config: `./payment-daemon-config.yaml`) on socket `/var/run/livepeer/payment-daemon.sock`
- `minimal-shell` (this example) bind-mounting both sockets

`examples/minimal-shell/README.md`: clone, `npm install`, fill in the two daemon config files (worker pool list for the registry, escrow/keystore for the payer), `docker compose up`, `curl http://localhost:8080/v1/chat/completions ...`. End-to-end in 1–2 minutes (daemon spinup is the long part).

### 4. CI workflows

`.github/workflows/ci.yml`:

```yaml
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['20', '22']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
```

`.github/workflows/publish.yml`:

```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: { id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', registry-url: 'https://registry.npmjs.org' }
      - run: npm ci
      - run: npm run build
      - run: npm publish --access public
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
```

`NPM_TOKEN` is a repo secret with publish rights to the `@cloud-spe` scope. Manual ops step.

### 5. npm publish

```bash
cd livepeer-bridge-core
npm version 0.1.0
git push origin main --tags
# CI publishes
```

Pre-publish smoke: `npm pack` → install the resulting tarball into `examples/minimal-shell/` in a fresh directory, confirm runs.

### 6. This repo: swap workspace dep for npm dep

After publish, in this repo (now `livepeer-openai-gateway`):

- Edit `packages/livepeer-openai-gateway/package.json`:
  ```json
  "@cloud-spe/bridge-core": "^0.1.0"
  ```
  (was `"workspace:*"`)
- `git rm -r packages/bridge-core/`
- Root `package.json` workspaces no longer include `packages/bridge-core` (only `packages/livepeer-openai-gateway` and `bridge-ui/*`).
- `npm install` resolves the engine from the registry.
- All tests, lint, typecheck pass. The shell now consumes the published engine.

This is a one-shot transition. After this point, engine changes flow: PR → public repo → release tag → npm → bump in this repo.

### 7. Versioning + breaking changes (pre-1.0 policy)

Documented in `CHANGELOG.md` and engine `README.md`:

> Pre-1.0: this package is iterating fast. Breaking changes may land in any 0.x release. We document them in `CHANGELOG.md`. 1.0 will be cut when the first external operator successfully runs on this engine — at that point we commit to strict semver.

This repo's policy: pin to `^0.1.0` style range; bump explicitly. No auto-update.

### 8. Public-facing README content

`README.md` must:
- One-paragraph elevator pitch (OpenAI-compatible engine fronting Livepeer worker pools; bring your own billing/auth/rate-limit via adapters).
- Quickstart (`npm install @cloud-spe/bridge-core` → minimal-shell example).
- Adapter overview (Wallet, AuthResolver, RateLimiter, Logger, AdminAuthResolver).
- Architecture diagram (engine vs. operator-supplied adapters).
- **Ecosystem integration section** (must appear prominently):
  - **Required sidecar daemons**: `livepeer-payment-daemon` (sender mode) for ticket creation; `livepeer-service-registry-daemon` for node discovery and selection. Both are gRPC over unix sockets by default.
  - Repo links: `livepeer-cloud-spe/livepeer-modules-project/payment-daemon`, `livepeer-cloud-spe/livepeer-modules-project/service-registry-daemon`.
  - Note: the engine does NOT support a static-YAML fallback; the registry-daemon is required for production and for the minimal-shell example.
  - `livepeer-cloud-spe/livepeer-modules-project/protocol-daemon` is **orthogonal** — orchestrator-side concern, not needed by bridge operators unless they also run an orchestrator.
- Link to `examples/minimal-shell/`, `docs/adapters.md`, `docs/architecture.md`.
- Link to `Cloud-SPE/livepeer-openai-gateway` as a reference shell implementation (this repo).
- Reference to `livepeer-cloud-spe/livepeer-modules-conventions` for cross-ecosystem metric naming and port allocation conventions.
- License: MIT.

The full ecosystem-readiness pieces (CONTRIBUTING, SECURITY, etc.) come from [`0028-oss-readiness.md`](./0028-oss-readiness.md), running in parallel.

### 9. Doc carve-out from this repo

Engine-relevant design-docs that move (copy + history-discarded since the public repo starts fresh):

- `docs/design-docs/node-lifecycle.md` → public
- `docs/design-docs/payer-integration.md` → public
- `docs/design-docs/pricing-model.md` → public (with margin terminology generalized: "operator margin" instead of "Cloud-SPE margin")
- `docs/design-docs/streaming-semantics.md` → public
- `docs/design-docs/token-audit.md` → public
- `docs/design-docs/retry-policy.md` → public
- `docs/design-docs/metrics.md` → public (engine-side metric catalog)
- `docs/design-docs/operator-dashboard.md` → public (added in stage 2)
- `docs/references/openai-bridge-architecture.md` → splits: an engine-architecture variant lives in the public repo; a shell-architecture variant stays here.

This repo retains:
- `docs/design-docs/tiers.md` (customer tiers — shell concept)
- `docs/design-docs/stripe-integration.md`
- `docs/design-docs/ui-architecture.md`
- `docs/design-docs/core-beliefs.md` (with engine-specific beliefs forked into the public repo's own version)

The historical record of HOW the engine was extracted lives in this repo's `docs/exec-plans/completed/0024-0027-*` after they archive. The public repo starts its own `docs/exec-plans/` clean.

## Steps

- [ ] Manual: `gh repo create Cloud-SPE/livepeer-bridge-core --public ...`
- [ ] Local: clone the empty repo, copy `packages/bridge-core/*` content over, prune workspace-specific config (root package.json reference)
- [ ] Add MIT `LICENSE`, placeholder OSS-readiness files (real content from [`0028`](./0028-oss-readiness.md))
- [ ] Carve engine-side design-docs into the public repo's `docs/`
- [ ] Build `examples/minimal-shell/` (start script, package.json, `compose.yaml` bringing up payment-daemon + service-registry-daemon as sidecars, `service-registry-config.yaml`, `payment-daemon-config.yaml`, README walkthrough)
- [ ] Write public `README.md` (elevator pitch, quickstart, adapters, architecture diagram, ecosystem links)
- [ ] Add `.github/workflows/ci.yml` + `publish.yml`
- [ ] Manual: configure `NPM_TOKEN` secret in the public repo
- [ ] Smoke: `npm pack` locally → install into a temp directory → run `examples/minimal-shell/start.ts`
- [ ] Initial commit + push to `Cloud-SPE/livepeer-bridge-core`
- [ ] Tag `v0.1.0`, push tag, observe CI publish
- [ ] In this repo: edit `packages/livepeer-openai-gateway/package.json` to swap workspace dep for `^0.1.0`
- [ ] In this repo: `git rm -r packages/bridge-core/`; update root `package.json` workspaces array
- [ ] In this repo: `npm install` → confirm tests/lint/typecheck pass against the published engine
- [ ] Update this repo's `README.md` to link the public engine repo
- [ ] Move stages 0024–0027 from `docs/exec-plans/active/` → `docs/exec-plans/completed/`

## Decisions log

(empty)

## Open questions

(none at plan-write time)

## Artifacts produced

(empty until in-flight)
