---
id: 0025
slug: engine-extraction-dispatchers
title: Engine extraction stage 2 — extract framework-free dispatchers from runtime/http/* route handlers; split AdminService into engine + shell halves; scaffold the read-only operator dashboard
status: active
owner: agent
opened: 2026-04-26
---

## Goal

Stage 2 of a 4-stage extraction. With adapter interfaces in place from [`0024-engine-extraction-interfaces.md`](./0024-engine-extraction-interfaces.md), this stage pulls the orchestration logic out of the Fastify route handlers (`src/runtime/http/chat/completions.ts`, `streaming.ts`, `embeddings/`, `images/`, `audio/`) into framework-free dispatcher functions under a new `src/dispatch/` directory. Each dispatcher takes adapter dependencies (`wallet`, `caller`, `body`, plus engine providers) and returns the response — no Fastify dependency, unit-testable in isolation, callable from any HTTP framework.

This stage also splits the existing `AdminService` into an engine half (node + payment ops: `listNodes`, `nodeDetail`, `listReservations`, `nodesConfigView`) and a shell half (customer ops: `searchCustomers`, `customerDetail`, `searchTopups`, `auditFeed`, `issueKey`, `refund`, `suspend`, `unsuspend`). Two separate service factories, two separate route registration functions, both wired through the same `adminAuth` middleware.

Finally, this stage scaffolds the engine's optional read-only operator dashboard at `src/dashboard/` (vanilla TS, server-rendered HTML + minimal client JS, no Lit/RxJS dependencies, no shared code with `bridge-ui/`). Mounted via a Fastify plugin at `/admin/ops/*`. v1 is read-only (node health, quote freshness, payer-daemon status, recent dispatches, build info). Action surface deferred to backlog.

By the end of this stage the route handlers are 20–40 lines each and call into the dispatcher; dispatcher unit tests run without HTTP; the engine dashboard shows up at `/admin/ops/` behind the `AdminAuthResolver` adapter; all existing tests pass.

## Non-goals

- No npm workspace conversion (stage 3).
- No schema changes (stage 3).
- No public repo or npm publish (stage 4).
- No file moves into `packages/` (stage 3).
- No replacement of `bridge-ui/admin/` — this dashboard is the *engine's* OSS-adopter dashboard, separate from the shell's full operator console. Different audience, different stack.
- No action surface on the engine dashboard. Read-only v1; circuit-break/refresh-quote/etc. defer to a follow-up plan.
- No Lit, no RxJS, no Vite for the engine dashboard — keeps engine peer-dep footprint minimal.
- No splitting of `bridge-ui/admin/` itself; that stays one shell-side SPA.

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

### 4. AdminService split

Create:

- `src/service/admin/engine.ts` — `createEngineAdminService({db, nodeBook, payerDaemon, redis}) → EngineAdminService`. Methods: `listNodes`, `nodeDetail`, `listReservationsByState`, `nodesConfigView`.
- `src/service/admin/shell.ts` — `createShellAdminService({db, authService, billingService}) → ShellAdminService`. Methods: `searchCustomers`, `customerDetail`, `searchTopups`, `auditFeed`, `issueKey`, `refund`, `suspend`, `unsuspend`.

Existing `src/service/admin/index.ts` is retired (its callers split between the two new factories).

`src/runtime/http/admin/routes.ts` is split into:

- `registerEngineAdminRoutes(app, {adminAuthResolver, engineAdminService})` — `/admin/nodes/*`, `/admin/reservations`, `/admin/config/nodes`
- `registerShellAdminRoutes(app, {adminAuthResolver, shellAdminService, db})` — `/admin/customers/*`, `/admin/topups`, `/admin/audit`

Both registrations use the same `adminAuth` middleware (which writes audit events). Audit-write stays in the middleware until stage 3 (where `admin_audit_events` becomes a shell-only table).

`src/main.ts` calls both registration functions, in order.

### 5. Engine operator dashboard scaffold

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

### 6. Tests

- `src/dispatch/*.test.ts` — dispatcher unit tests with `InMemoryWallet` (lands in this stage; ~60 LOC for prepaid-style + ~60 LOC for postpaid `reserve → null`) and mock providers. No Fastify in the loop. Cover: success, reserve-fail, node-call-fail, missing-usage, partial-stream-failure (streaming dispatcher only).
- Existing route tests stay green — they now exercise the Fastify wrappers + the dispatchers transitively.
- New `src/service/admin/{engine,shell}.test.ts` — TestPg-backed tests for the split services.
- New `src/dashboard/routes.test.ts` — Fastify integration test, asserts 401 without auth, asserts 200 + expected HTML fragments with auth.
- Coverage stays ≥ 75%; ratchet up if dispatcher unit tests push it.

### 7. `InMemoryWallet` reference impl

`src/service/billing/inMemoryWallet.ts`:

- Map-backed reservation store.
- Implements `Wallet`. Used by dispatcher unit tests; flagged "not for production" in JSDoc.
- Lands in stage 2 (not stage 3) so dispatcher tests can use it from day one.

### 8. Doc updates

- `docs/design-docs/architecture.md` — update layer diagram: `dispatch/` is a new sibling to `runtime/`, sits between `service/` and `runtime/`. Routes call dispatch; dispatch calls service.
- `docs/design-docs/streaming-semantics.md` — note the dispatcher boundary: streaming orchestration lives in `src/dispatch/streamingChatCompletion.ts`; the Fastify wrapper only handles SSE wire mechanics.
- New `docs/design-docs/operator-dashboard.md` — engine dashboard scope, mount, auth, v1 read-only constraint.

## Steps

- [ ] Create `src/dispatch/` with chatCompletion, streamingChatCompletion, embeddings, images, speech, transcriptions
- [ ] Reduce each `src/runtime/http/{chat,embeddings,images,audio}/*.ts` route handler to a thin Fastify wrapper
- [ ] Implement `InMemoryWallet` for dispatcher tests
- [ ] Write dispatcher unit tests (no Fastify, with InMemoryWallet)
- [ ] Split `src/service/admin/index.ts` → `engine.ts` + `shell.ts`
- [ ] Split `src/runtime/http/admin/routes.ts` → `engine.ts` + `shell.ts` registration functions
- [ ] Scaffold `src/dashboard/` with routes, views, client JS, CSS
- [ ] Implement `createBasicAdminAuthResolver` (env-driven default)
- [ ] Wire dashboard mount in `main.ts` (env-gated)
- [ ] Update existing route + admin tests; add dashboard integration test
- [ ] Update `docs/design-docs/architecture.md`, `streaming-semantics.md`; add `operator-dashboard.md`
- [ ] Verify `npm run lint`, `typecheck`, `test` (≥ 75%), `doc-lint` all pass

## Decisions log

(empty)

## Open questions

(none at plan-write time)

## Artifacts produced

(empty until in-flight)
