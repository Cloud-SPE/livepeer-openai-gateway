---
id: 0025
slug: engine-extraction-dispatchers
title: Engine extraction stage 2 — extract framework-free dispatchers from runtime/http/* route handlers; split AdminService into engine + shell halves; replace NodeBook with the service-registry-daemon gRPC client and retire nodes.yaml; scaffold the read-only operator dashboard
status: active
owner: agent
opened: 2026-04-26
---

## Goal

Stage 2 of a 4-stage extraction. With adapter interfaces in place from [`0024-engine-extraction-interfaces.md`](./0024-engine-extraction-interfaces.md), this stage pulls the orchestration logic out of the Fastify route handlers (`src/runtime/http/chat/completions.ts`, `streaming.ts`, `embeddings/`, `images/`, `audio/`) into framework-free dispatcher functions under a new `src/dispatch/` directory. Each dispatcher takes adapter dependencies (`wallet`, `caller`, `body`, plus engine providers) and returns the response — no Fastify dependency, unit-testable in isolation, callable from any HTTP framework.

This stage also splits the existing `AdminService` into an engine half (node + payment ops: `listNodes`, `nodeDetail`, `listReservations`, `nodesConfigView`) and a shell half (customer ops: `searchCustomers`, `customerDetail`, `searchTopups`, `auditFeed`, `issueKey`, `refund`, `suspend`, `unsuspend`). Two separate service factories, two separate route registration functions, both wired through the same `adminAuth` middleware.

This stage also retires the engine's static node registry. The `ServiceRegistryClient` interface defined in [`0024`](./0024-engine-extraction-interfaces.md) gets its real implementation: a gRPC client to `livepeer-modules-project/service-registry-daemon`. `NodeBook`, `loader.ts`, `nodes.yaml`, and the `src/service/nodes/` directory retire. Selection moves daemon-side via `Select(capability, model, tier, geo, excludeIds)` calls. Quote refresh and circuit-breaker stay bridge-side (they're per-process state, not shared). The `service/nodes/` files that aren't strictly node-discovery (`quoteRefresher`, `circuitBreaker`, `scheduler`) move into `service/routing/`. The bridge now requires both daemons (payment + service-registry) as sidecars.

Finally, this stage scaffolds the engine's optional read-only operator dashboard at `src/dashboard/` (vanilla TS, server-rendered HTML + minimal client JS, no Lit/RxJS dependencies, no shared code with `bridge-ui/`). Mounted via a Fastify plugin at `/admin/ops/*`. v1 is read-only (node health, quote freshness, payer-daemon status, recent dispatches, build info). Action surface deferred to backlog.

By the end of this stage the route handlers are 20–40 lines each and call into the dispatcher; dispatcher unit tests run without HTTP; `nodes.yaml` is gone; the bridge resolves nodes via the registry-daemon; the engine dashboard shows up at `/admin/ops/` behind the `AdminAuthResolver` adapter; all existing tests pass.

## Non-goals

- No npm workspace conversion (stage 3).
- No schema changes (stage 3).
- No public repo or npm publish (stage 4).
- No file moves into `packages/` (stage 3).
- No replacement of `bridge-ui/admin/` — this dashboard is the *engine's* OSS-adopter dashboard, separate from the shell's full operator console. Different audience, different stack.
- No action surface on the engine dashboard. Read-only v1; circuit-break/refresh-quote/etc. defer to a follow-up plan.
- No Lit, no RxJS, no Vite for the engine dashboard — keeps engine peer-dep footprint minimal.
- No splitting of `bridge-ui/admin/` itself; that stays one shell-side SPA.
- No fallback to static `nodes.yaml` once the registry-daemon client lands. The engine commits to the daemon as the canonical discovery source; OSS adopters who can't run the daemon are out of scope for v1.
- No daemon-side circuit-breaker or daemon-side quote cache. Both stay bridge-local.
- No registry-daemon installation, configuration, or deployment changes inside this repo's compose — those are stage 3 (workspace) where compose layouts get touched.

## Approach

### 1. Extract chat-completions dispatcher

Create `src/dispatch/chatCompletion.ts`:

```ts
export interface ChatCompletionDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ChatCompletionRequest;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  logger?: Logger;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export async function dispatchChatCompletion(
  deps: ChatCompletionDispatchDeps,
): Promise<ChatCompletionResponse>;
```

Move the orchestration body from `src/runtime/http/chat/completions.ts:99-208` (the `try`/`catch` block) into this function. Substitute `wallet.reserve/commit/refund` for the direct `reserve()/commit()/refund()` calls. The reservation handle is opaque to the dispatcher.

`src/runtime/http/chat/completions.ts` becomes a thin Fastify wrapper:

```ts
app.post('/v1/chat/completions', { preHandler }, async (req, reply) => {
  const parsed = ChatCompletionRequestSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(...).send(...);
  if (parsed.data.stream === true) return handleStreamingChatCompletion(req, reply, ...);
  try {
    const response = await dispatchChatCompletion({ wallet, caller: req.caller, body: parsed.data, ...providers });
    await reply.code(200).send(response);
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
});
```

### 2. Extract streaming dispatcher

`src/dispatch/streamingChatCompletion.ts`. Same shape as above but yields SSE chunks via an `AsyncIterable<string>` or a write-callback, so the Fastify wrapper can pipe to `reply.raw`. Partial-commit semantics (commit prompt-only on mid-stream failure, refund completion) preserved verbatim — this is the trickiest dispatcher to test framework-free; pay close attention.

### 3. Extract embeddings, images, audio dispatchers

Same pattern:

- `src/dispatch/embeddings.ts` — extracts from `src/runtime/http/embeddings/index.ts`
- `src/dispatch/images.ts` — extracts from `src/runtime/http/images/generations.ts`
- `src/dispatch/speech.ts` — extracts from `src/runtime/http/audio/speech.ts`
- `src/dispatch/transcriptions.ts` — extracts from `src/runtime/http/audio/transcriptions.ts`

Each route handler shrinks to a Fastify wrapper that parses the body, calls the dispatcher, and sends the reply.

### 4. RegistryDaemonClient + retire NodeBook + reshape routing

The `ServiceRegistryClient` interface from stage 1 ([`0024`](./0024-engine-extraction-interfaces.md)) gets its real implementation, and the static-YAML path retires.

**4a. Generate proto stubs and add the gRPC client.**

- Add `livepeer-modules-project/service-registry-daemon/proto/...` to the bridge's `buf.gen.yaml` inputs (alongside the existing payer-daemon proto). Run `npm run proto:gen`; generated stubs land at `src/providers/serviceRegistry/gen/`.
- New provider: `src/providers/serviceRegistry/grpc.ts` — `createGrpcServiceRegistryClient({config, scheduler}) → ServiceRegistryClient`. Modelled on `src/providers/payerDaemon/grpc.ts`. Translates `Select`/`ListKnown` proto responses to `NodeRef[]`. Includes a periodic health-check loop (same pattern as payer-daemon's `startHealthLoop`).
- Optional `withMetrics` decorator at `src/providers/serviceRegistry/metered.ts` mirroring the payer-daemon's metrics decorator (RPC counts, latency histogram, error counts).

**4b. Config + main.ts wiring.**

- New config loader: `src/config/serviceRegistry.ts` exporting `loadServiceRegistryConfig()`. Reads `SERVICE_REGISTRY_SOCKET` (unix socket path; default `/var/run/livepeer/service-registry.sock`) or `SERVICE_REGISTRY_ADDRESS` (TCP fallback). Health-check interval, RPC timeout. Zod-validated.
- `src/main.ts`: replace the `createNodeBookRegistry` wiring from stage 1 with `createGrpcServiceRegistryClient(...)`. Remove the NodeBook construction, the YAML loader call, the `NODES_CONFIG_PATH` env var.
- Remove the `service/nodes/loader.ts` call site; remove the `nodes.yaml` / `nodes.example.yaml` references from the bridge's bootstrap.

**4c. Retire `src/service/nodes/`.**

Delete:
- `src/service/nodes/nodebook.ts` and `nodebook.test.ts`
- `src/service/nodes/loader.ts`
- `src/service/nodes/nodebookRegistry.ts` (the stage-1 wrap; replaced by the gRPC client)

Move:
- `src/service/nodes/quoteRefresher.ts` → `src/service/routing/quoteRefresher.ts`. Reshape: iterate over `serviceRegistry.listKnown()` instead of `nodeBook.allNodes()`. Quote cache becomes a separate module.
- `src/service/nodes/circuitBreaker.ts` → `src/service/routing/circuitBreaker.ts`. Now keyed by `nodeId` from the registry; tracks per-process exclusion timestamps. Default: 3 consecutive failures → 5-minute exclusion.
- `src/service/nodes/scheduler.ts` → `src/service/routing/scheduler.ts`. No content change.

Extract:
- New `src/service/routing/quoteCache.ts` — quote storage by `(nodeId, capabilityString)`; freshness TTL; getter used by dispatchers; setter used by `quoteRefresher`.

**4d. Reshape `src/service/routing/router.ts`.**

The `pickNode` function changes shape to use daemon-side selection with bridge-local circuit-breaker exclusion (option **a2** from stage-0 discussion):

```ts
export async function pickNode(
  deps: { serviceRegistry: ServiceRegistryClient; circuitBreaker: CircuitBreaker; rng?: () => number },
  capability: Capability,
  model: string,
  callerTier: string,
): Promise<NodeRef> {
  const maxRetries = 3;
  const excludeIds = deps.circuitBreaker.currentExclusions();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const nodes = await deps.serviceRegistry.select({
      capability, model, tier: callerTier,
      excludeIds: [...excludeIds, ...deps.circuitBreaker.currentExclusions()],
    });
    if (nodes.length === 0) {
      // All known nodes excluded; signal NoEligibleNodesError up to dispatcher.
      throw new NoEligibleNodesError(capability, model, callerTier);
    }
    // Weighted-random pick locally; daemon ordering is hint, not authoritative.
    const picked = weightedRandom(nodes, deps.rng);
    return picked;
  }
  throw new NoEligibleNodesError(capability, model, callerTier);
}
```

Circuit-breaker registers a failure when a dispatcher catches `UpstreamNodeError`/`MissingUsageError` from a particular `nodeId`. After 3 consecutive failures, the node is added to `currentExclusions()` for 5 minutes. The exclusion set is per-process, never persisted.

**4e. Dispatcher integration.**

Each dispatcher (chat, embeddings, images, speech, transcriptions) now takes `serviceRegistry` and `circuitBreaker` deps instead of `nodeBook`:

```ts
export interface ChatCompletionDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ChatCompletionRequest;
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  quoteCache: QuoteCache;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  // ... rest unchanged
}
```

The dispatcher calls `pickNode(...)`, fetches the cached quote via `quoteCache.get(nodeId, capability)`, hits the worker via `nodeClient`, and reports failures to the circuit-breaker on error paths.

### 5. AdminService split

Create:

- `src/service/admin/engine.ts` — `createEngineAdminService({db, serviceRegistry, payerDaemon, redis}) → EngineAdminService`. Methods: `listNodes` (delegates to `serviceRegistry.listKnown()`), `nodeDetail`, `listReservationsByState`, `nodesConfigView` (returns the currently-resolved registry snapshot — reads from the daemon, no longer the `nodes.yaml` file).
- `src/service/admin/shell.ts` — `createShellAdminService({db, authService, billingService}) → ShellAdminService`. Methods: `searchCustomers`, `customerDetail`, `searchTopups`, `auditFeed`, `issueKey`, `refund`, `suspend`, `unsuspend`.

Existing `src/service/admin/index.ts` is retired (its callers split between the two new factories).

`src/runtime/http/admin/routes.ts` is split into:

- `registerEngineAdminRoutes(app, {adminAuthResolver, engineAdminService})` — `/admin/nodes/*`, `/admin/reservations`, `/admin/config/nodes`
- `registerShellAdminRoutes(app, {adminAuthResolver, shellAdminService, db})` — `/admin/customers/*`, `/admin/topups`, `/admin/audit`

Both registrations use the same `adminAuth` middleware (which writes audit events). Audit-write stays in the middleware until stage 3 (where `admin_audit_events` becomes a shell-only table).

`src/main.ts` calls both registration functions, in order.

### 6. Engine operator dashboard scaffold

Layout:

```
src/dashboard/
├── index.ts              # registerOperatorDashboard(app, {mountPath, adminAuthResolver}) Fastify plugin
├── routes.ts             # GET /admin/ops/, /admin/ops/nodes, /admin/ops/payer, /admin/ops/dispatches
├── views/
│   ├── layout.ts         # HTML skeleton + minimal CSS inline
│   ├── status.ts         # node + payer-daemon status table
│   ├── quotes.ts         # quote freshness per node
│   └── dispatches.ts     # last 50 dispatches (engine-side usage_records read)
├── client/
│   └── refresh.ts        # ~80 LOC vanilla JS — periodic fetch + DOM update
└── static/
    └── style.css         # minimal CSS (~100 lines)
```

- Server-rendered HTML on the routes (template strings; no SSR framework).
- Client JS is loaded as a single script tag, polls a JSON endpoint every 5s for live status, updates DOM nodes by data-attribute selectors.
- Auth: every request goes through `adminAuthResolver.resolve(req)`; failures return 401.
- v1 read-only: status tiles, recent dispatches table, quote-freshness table, build-info footer. No buttons.

Default `AdminAuthResolver` (basic-auth from env: `BRIDGE_OPS_USER` + `BRIDGE_OPS_PASS`) ships alongside as `src/service/admin/basicAuthResolver.ts`. Engine operators with no shell wire `createBasicAdminAuthResolver(env)` instead of the shell's token-based one.

`src/main.ts` mounts the dashboard:

```ts
registerOperatorDashboard(server.app, {
  mountPath: '/admin/ops',
  adminAuthResolver,
});
```

Mounting is opt-in via env (`BRIDGE_DASHBOARD_ENABLED=true`); off by default in this repo since the shell has its own admin SPA.

### 7. Tests

- `src/dispatch/*.test.ts` — dispatcher unit tests with `InMemoryWallet` (lands in this stage; ~60 LOC for prepaid-style + ~60 LOC for postpaid `reserve → null`) and mock providers. No Fastify in the loop. Cover: success, reserve-fail, node-call-fail, missing-usage, partial-stream-failure (streaming dispatcher only).
- New `src/providers/serviceRegistry/grpc.test.ts` — gRPC client smoke (mock daemon via in-process gRPC server).
- New `src/service/routing/router.test.ts` — `pickNode` with mock `ServiceRegistryClient`: success, all-excluded retry-then-fail, weighted-random distribution under fixed RNG.
- New `src/service/routing/circuitBreaker.test.ts` — failure counting, exclusion TTL, recovery.
- New `src/service/routing/quoteCache.test.ts` — TTL eviction, get/set semantics.
- New `src/service/routing/quoteRefresher.test.ts` — iterates `serviceRegistry.listKnown()`, polls workers, populates `quoteCache`.
- Existing route tests stay green — they now exercise the Fastify wrappers + the dispatchers transitively, with a mock `ServiceRegistryClient` returning fixture nodes.
- New `src/service/admin/{engine,shell}.test.ts` — TestPg-backed tests for the split services.
- New `src/dashboard/routes.test.ts` — Fastify integration test, asserts 401 without auth, asserts 200 + expected HTML fragments with auth.
- Coverage stays ≥ 75%; ratchet up if dispatcher unit tests push it.

### 8. `InMemoryWallet` reference impl

`src/service/billing/inMemoryWallet.ts`:

- Map-backed reservation store.
- Implements `Wallet`. Used by dispatcher unit tests; flagged "not for production" in JSDoc.
- Lands in stage 2 (not stage 3) so dispatcher tests can use it from day one.

### 9. Doc updates

- `docs/design-docs/architecture.md` — update layer diagram: `dispatch/` is a new sibling to `runtime/`, sits between `service/` and `runtime/`. Routes call dispatch; dispatch calls service. Note that `src/service/nodes/` has retired and moved to `src/service/routing/` (`quoteRefresher`, `circuitBreaker`, `scheduler`, plus new `quoteCache`).
- `docs/design-docs/streaming-semantics.md` — note the dispatcher boundary: streaming orchestration lives in `src/dispatch/streamingChatCompletion.ts`; the Fastify wrapper only handles SSE wire mechanics.
- `docs/design-docs/node-lifecycle.md` — replace the static-YAML/`NodeBook` model with the registry-daemon model. Selection is daemon-side; quote refresh, quote cache, and circuit-breaker are bridge-local. Document the `excludeIds` retry semantics.
- Retire `nodes.example.yaml` from the repo. Replace with `service-registry-daemon.example.yaml` (config snippet) and a `compose.yaml` example showing both daemons as sidecars.
- New `docs/design-docs/operator-dashboard.md` — engine dashboard scope, mount, auth, v1 read-only constraint.

## Steps

- [ ] Create `src/dispatch/` with chatCompletion, streamingChatCompletion, embeddings, images, speech, transcriptions
- [ ] Reduce each `src/runtime/http/{chat,embeddings,images,audio}/*.ts` route handler to a thin Fastify wrapper
- [ ] Implement `InMemoryWallet` for dispatcher tests
- [ ] Write dispatcher unit tests (no Fastify, with InMemoryWallet)
- [ ] Add `service-registry-daemon` proto to `buf.gen.yaml`; run `npm run proto:gen`
- [ ] Implement `src/providers/serviceRegistry/grpc.ts` (gRPC client) + `metered.ts` (metrics decorator)
- [ ] Add `src/config/serviceRegistry.ts` config loader
- [ ] Replace `createNodeBookRegistry` wiring in `main.ts` with `createGrpcServiceRegistryClient`
- [ ] Move `quoteRefresher.ts`, `circuitBreaker.ts`, `scheduler.ts` from `service/nodes/` → `service/routing/`; extract `quoteCache.ts`
- [ ] Reshape `service/routing/router.ts:pickNode` to use daemon-side `select()` + bridge-local exclusion retry (option a2)
- [ ] Update each dispatcher's deps to `serviceRegistry` + `circuitBreaker` + `quoteCache` (replacing `nodeBook`)
- [ ] Delete `src/service/nodes/` directory; delete `nodes.yaml` + `nodes.example.yaml`; remove `NODES_CONFIG_PATH` env var
- [ ] Split `src/service/admin/index.ts` → `engine.ts` + `shell.ts` (engine half consumes `serviceRegistry`)
- [ ] Split `src/runtime/http/admin/routes.ts` → `engine.ts` + `shell.ts` registration functions
- [ ] Scaffold `src/dashboard/` with routes, views, client JS, CSS
- [ ] Implement `createBasicAdminAuthResolver` (env-driven default)
- [ ] Wire dashboard mount in `main.ts` (env-gated)
- [ ] Update existing route + admin tests with mock `ServiceRegistryClient`; add new tests for grpc client, router, circuitBreaker, quoteCache, quoteRefresher; add dashboard integration test
- [ ] Update `docs/design-docs/architecture.md`, `streaming-semantics.md`, `node-lifecycle.md`; add `operator-dashboard.md`; replace `nodes.example.yaml` with `service-registry-daemon.example.yaml` + compose example
- [ ] Verify `npm run lint`, `typecheck`, `test` (≥ 75%), `doc-lint` all pass

## Decisions log

(empty)

## Open questions

(none at plan-write time)

## Artifacts produced

(empty until in-flight)
