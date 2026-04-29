---
id: 0024
slug: engine-extraction-interfaces
title: Engine extraction stage 1 — define Wallet/AuthResolver/RateLimiter/Logger/AdminAuthResolver adapter interfaces in-place; introduce generic Caller; thread caller_id through engine-bound code
status: completed
owner: agent
opened: 2026-04-26
closed: 2026-04-26
---

## Goal

Stage 1 of a 4-stage extraction that splits this codebase into an OSS engine (`@cloud-spe/bridge-core`, MIT, npm-published, public repo `Cloud-SPE/livepeer-bridge-core`) and a proprietary shell (this repo, renaming to `livepeer-openai-gateway`). Stage 1 establishes the five operator-overridable adapter contracts the engine will expose, refactors existing code to implement them in-place (no file moves, no schema changes, no workspace conversion), threads a generic `Caller {id, tier, metadata?}` in front of the current `CustomerRow`-typed flow, and additionally defines a `ServiceRegistryClient` provider interface that wraps today's `NodeBook` so the rest of the codebase calls a registry-shaped API. The actual gRPC client to `livepeer-modules-project/service-registry-daemon` and the retirement of `NodeBook`/`nodes.yaml` come in stage 2 — this stage only stands up the interface so the swap is mechanical there. By the end of this stage the codebase still ships as a single binary with no behavior change, but the engine/shell seam is explicit in code and validated by passing tests.

The five operator-overridable adapter interfaces, locked-in:

- `Wallet` — `reserve(callerId, CostQuote) → ReservationHandle | null`; `commit(handle, UsageReport) → void`; `refund(handle) → void` (best-effort, errors swallowed). The existing `service/billing/reservations.ts` (prepaid + quota branches) is wrapped behind a single `Wallet` impl. `null` from `reserve` means "no reservation needed" (postpaid pattern).
- `AuthResolver` — `resolve(req) → Caller | null` (null → 401). Today's `service/auth/authenticate.ts` becomes the default impl. `Caller.tier` is an operator-defined string the engine plumbs through but does not own.
- `RateLimiter` — already optional in route deps. Generalize the key from `customerId` to `callerId`.
- `Logger` — minimal `info/warn/error`. Default impl uses `console.{warn,error}`. Threaded through `main.ts` and the engine-bound providers that currently `console.warn(...)` directly.
- `AdminAuthResolver` — hook for the operator dashboard auth (default impl wraps existing `X-Admin-Token` + `X-Admin-Actor` middleware). Stage 2 mounts the engine dashboard behind it; this stage just defines the contract.

Plus one engine-internal provider interface (NOT operator-overridable; the engine commits to `livepeer-modules-project/service-registry-daemon` as the canonical discovery source):

- `ServiceRegistryClient` — `select(query) → NodeRef[]`; `listKnown(capability?) → NodeRef[]`. Lives at `src/providers/serviceRegistry.ts`. Today's `NodeBook` is wrapped to implement this interface in stage 1. Stage 2 replaces the NodeBook-backed impl with a real gRPC client to the daemon and retires `nodes.yaml`. Selection moves daemon-side; circuit-breaker stays bridge-local (per-process exclusion set retried against `select` until exhausted).

Zero behavior change. All current tests pass unchanged or with surface-level edits.

## Non-goals

- No file moves between engine-bound and shell-bound code.
- No schema changes. `customer_id` columns stay; `callerId` is a parameter at the adapter boundary, not a column rename.
- No npm workspace conversion (stage 3).
- No `dispatch/*` extraction (stage 2).
- No operator dashboard scaffold (stage 2).
- No public repo or npm publish (stage 4).
- No new HTTP routes.
- No removal of the legacy `MetricsSink` interface (already tracked under metrics phase 2).
- No replacement of every `console.warn` call — only the ones in code paths that will move to the engine in stage 3.
- No splitting of the AdminService yet (stage 2).
- No registry-daemon gRPC client implementation (stage 2). `NodeBook` stays in place wrapped behind `ServiceRegistryClient`; `nodes.yaml` stays.
- No retirement of `service/nodes/` (stage 2).
- No reshape of `service/routing/router.ts` to use daemon-side selection (stage 2).

## Approach

### 1. Define interfaces

Create `src/interfaces/` (new directory, peer to `src/types/`; flagged in stage 3 for relocation to `packages/bridge-core/src/interfaces/`):

```
src/interfaces/
├── index.ts                 # barrel
├── caller.ts                # Caller, CostQuote, UsageReport, ReservationHandle types
├── wallet.ts                # Wallet interface
├── authResolver.ts          # AuthResolver interface
├── rateLimiter.ts           # RateLimiter interface (relocated from service/rateLimit/index.ts)
├── logger.ts                # Logger interface
└── adminAuthResolver.ts     # AdminAuthResolver interface
```

Type shapes (final, locked):

```ts
export interface Caller {
  id: string;
  tier: string;
  metadata?: unknown;
}

export type Capability = 'chat' | 'embeddings' | 'images' | 'speech' | 'transcriptions';

export interface CostQuote {
  cents: number;
  wei: bigint;
  estimatedTokens: number;
  model: string;
  capability: Capability;
  callerTier: string;
}

export interface UsageReport {
  cents: number;
  wei: bigint;
  actualTokens: number;
  model: string;
  capability: Capability;
}

export type ReservationHandle = unknown;

export interface Wallet {
  reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle | null>;
  commit(handle: ReservationHandle, usage: UsageReport): Promise<void>;
  refund(handle: ReservationHandle): Promise<void>;
}

export interface AuthResolver {
  resolve(req: { headers: Record<string, string | undefined>; ip: string }): Promise<Caller | null>;
}

export interface RateLimiter {
  consume(callerId: string, tier: string): Promise<{ allowed: boolean; resetMs: number }>;
}

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown> | Error): void;
}

export interface AdminAuthResolver {
  resolve(req: {
    headers: Record<string, string | undefined>;
    ip: string;
  }): Promise<{ actor: string } | null>;
}
```

### 2. Wallet impl wrapping existing billing code

`src/service/billing/wallet.ts` (new): `createPrepaidQuotaWallet({db}) → Wallet` factory.

- `reserve(callerId, quote)`: reads `customers.tier` (resolves prepaid vs quota), branches to existing `reserve()` or `reserveQuota()`. Returns `{kind: 'prepaid' | 'quota', reservationId}` as the opaque handle.
- `commit(handle, usage)`: branches to existing `commit()` or `commitQuota()` using `usage.cents` (prepaid) or `usage.actualTokens` (quota).
- `refund(handle)`: branches to existing `refund()` or `refundQuota()`. Errors swallowed (best-effort).

Existing `reserve/reserveQuota/commit/commitQuota/refund/refundQuota` functions stay untouched as private impl details. Only the wallet wrapper is new.

### 3. AuthResolver impl wrapping existing AuthService

`src/service/auth/authResolver.ts` (new): `createAuthResolver({authService}) → AuthResolver`.

- Extracts bearer token (existing logic from `authPreHandler`), calls `authService.authenticate(token)`.
- Returns `{id: customer.id, tier: customer.tier, metadata: {customer, apiKey}} | null`.

`src/runtime/http/middleware/auth.ts` becomes a thin wrapper that calls `authResolver.resolve(req)` and assigns `req.caller`. Fastify type augmentation switches to `caller: Caller` (generic). Shell-specific consumers narrow via `caller.metadata as {customer, apiKey}`.

### 4. Logger interface + threading

`src/providers/logger/console.ts` (new): default impl using `console.warn`/`console.error` with the existing `[bridge]` prefix convention.

In `src/main.ts`:

- Construct a `Logger` once.
- Pass it to engine-bound providers and services that currently call `console.*` directly: `providers/payerDaemon/grpc.ts`, `service/nodes/quoteRefresher.ts`, the metrics server, the shutdown handler.

Out of scope: replacing every `console.*` call repo-wide. Touch only call sites in code that will relocate to the engine in stage 3.

### 5. RateLimiter relocation + rename

- Move the `RateLimiter` interface from `src/service/rateLimit/index.ts` to `src/interfaces/rateLimiter.ts`.
- Rename method param `customerId` → `callerId`.
- Per-tier config remains keyed by tier string (no change).
- The Redis sliding-window default impl stays at `src/service/rateLimit/index.ts`.

### 6. AdminAuthResolver wrapping existing middleware

`src/service/admin/authResolver.ts` (new): `createAdminAuthResolver({config: AdminConfig}) → AdminAuthResolver`.

Wraps the `X-Admin-Token` (timing-safe) + `X-Admin-Actor` (regex `^[a-z0-9._-]{1,64}$`) validation logic from `src/runtime/http/middleware/adminAuth.ts`. Returns `{actor}` on success, `null` on failure.

Existing `adminAuth` Fastify middleware stays — it now calls `adminAuthResolver.resolve(req)` and writes the audit event. Audit write stays in the middleware (shell concern; relocates in stage 3).

### 7. ServiceRegistryClient interface + NodeBook wrap

`src/providers/serviceRegistry.ts` (new): provider type, modelled on the existing `src/providers/payerDaemon.ts`.

```ts
export interface NodeRef {
  id: string;
  url: string;
  capabilities: Capability[];
  weight?: number;
  metadata?: unknown;
}

export interface SelectQuery {
  capability: Capability;
  model?: string;
  tier?: string;
  excludeIds?: string[];
}

export interface ServiceRegistryClient {
  select(query: SelectQuery): Promise<NodeRef[]>;
  listKnown(capability?: Capability): Promise<NodeRef[]>;
}
```

`src/service/nodes/nodebookRegistry.ts` (new): `createNodeBookRegistry({nodeBook}) → ServiceRegistryClient`.

- `select(query)`: today's `nodeBook.findByCapabilityAndTier(query.capability, query.tier)` filtered by `query.excludeIds`. No weighted-random sort here; the caller (`pickNode`) still does selection in stage 1.
- `listKnown(capability?)`: returns NodeRefs derived from `nodeBook.allNodes()` (filtered by capability if provided).

Existing call sites (`src/service/routing/router.ts:pickNode`, `src/service/nodes/quoteRefresher.ts`) keep using `NodeBook` directly in stage 1 — they switch to the `ServiceRegistryClient` interface in stage 2 when the gRPC client lands. This stage just stands the interface up so the swap is mechanical there.

### 8. Wire adapters in main.ts

```ts
const logger = createConsoleLogger();
const authResolver = createAuthResolver({ authService });
const wallet = createPrepaidQuotaWallet({ db });
const adminAuthResolver = createAdminAuthResolver({ config: adminConfig });
const serviceRegistry = createNodeBookRegistry({ nodeBook });
```

Pass these alongside the lower-level dependencies into route registrations. Route handlers continue to call lower-level functions internally — the adapter pass-through is wired but not yet exclusive (that's stage 2).

### 9. Tests

- `src/interfaces/*.test.ts` — type-shape and trivial-behavior tests.
- `src/service/billing/wallet.test.ts` — TestPg-backed prepaid/quota branch dispatch.
- `src/service/auth/authResolver.test.ts` — Caller construction, bearer-token edge cases.
- `src/service/admin/authResolver.test.ts` — token + actor validation.
- `src/service/nodes/nodebookRegistry.test.ts` — `select` filters, `excludeIds` honored, `listKnown` shape.
- Existing route tests (`src/runtime/http/{chat,embeddings,images,audio,account,admin}/*.test.ts`) — assert `req.caller` is a `Caller`; cast through `metadata` for shell-specific assertions.
- Coverage stays ≥ 75% across all v8 metrics. Ratchet up where the new interface tests push it.

### 10. Doc updates

- `docs/design-docs/architecture.md` — note that adapter interfaces have been added at `src/interfaces/` and document each shape; note that `ServiceRegistryClient` is an engine-internal provider interface (not operator-overridable) staged for stage-2 swap to a `livepeer-modules-project/service-registry-daemon` gRPC client. Layer rule unchanged.
- `docs/design-docs/index.md` — link any new architecture stub.

## Steps

- [ ] Create `src/interfaces/` with the six files (caller types + five operator-overridable interfaces) + barrel
- [ ] Implement `createPrepaidQuotaWallet` wrapping existing `service/billing/reservations.ts` branches
- [ ] Implement `createAuthResolver` wrapping `service/auth`; update Fastify `req.caller` augmentation to `Caller`
- [ ] Implement `createConsoleLogger`; thread through engine-bound `console.*` callers in `main.ts` + `providers/payerDaemon` + `service/nodes/quoteRefresher`
- [ ] Move `RateLimiter` interface; rename `customerId` param → `callerId`
- [ ] Implement `createAdminAuthResolver` wrapping `runtime/http/middleware/adminAuth.ts`
- [ ] Define `ServiceRegistryClient` provider interface at `src/providers/serviceRegistry.ts`; implement `createNodeBookRegistry` wrapping today's NodeBook
- [ ] Wire all five adapters + `serviceRegistry` in `main.ts`
- [ ] Add interface and impl unit tests; update existing route tests for the new `Caller` shape
- [ ] Update `docs/design-docs/architecture.md` and the design-docs index
- [ ] Verify `npm run lint`, `npm run typecheck`, `npm test` (≥ 75% coverage), `npm run doc-lint` all pass

## Decisions log

(empty — append as decisions emerge during implementation)

## Open questions

(none at plan-write time)

## Artifacts produced

(empty until in-flight)
