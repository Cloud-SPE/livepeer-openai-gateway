# Adapters

`@cloudspe/livepeer-gateway-core` is built around **five
operator-overridable adapters**. The engine commits to a tight
contract for each; everything else is internal and may change without
warning.

| Adapter | Purpose | Default impl shipped |
|---------|---------|---------------------|
| [`Wallet`](#wallet) | Billing/quota authority. Reserve before dispatch, commit on success, refund on failure. | `InMemoryWallet` (testing only) |
| [`AuthResolver`](#authresolver) | HTTP `Authorization` header → generic `Caller`. | none — operators wire their own |
| [`RateLimiter`](#ratelimiter) | Per-caller request gating. | Redis sliding-window |
| [`Logger`](#logger) | Structured log sink. | `createConsoleLogger` |
| [`AdminAuthResolver`](#adminauthresolver) | Admin-token / basic-auth backing for the operator dashboard. | `createBasicAdminAuthResolver` |

Below the adapter list, the engine has one **engine-internal provider
interface**: [`ServiceRegistryClient`](#non-adapter-serviceregistryclient).
It is _not_ on the operator-overridable list — the engine commits to
the [`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon)
as the canonical discovery source.

## Why adapters?

The engine handles the dispatch pipeline (auth → rate-limit → reserve
→ select node → call worker → commit), the OpenAI request/response
shape, the payment-daemon integration, and the metrics surface. The
adapters cover everything that varies by deployment:

- **Billing** is operator-specific. Postpaid B2B, prepaid USD,
  free-quota tokens, on-chain crypto — pick one or compose them.
- **Identity** is operator-specific. Bearer tokens, mTLS, OAuth-issued
  JWTs, custom header schemes.
- **Rate-limiting** is mostly the same everywhere, but the storage
  backend (Redis / Memcached / external) varies.
- **Logging** is mostly the same everywhere, but the sink (stdout /
  file / structured pipeline / external service) varies.
- **Admin auth** is operator-specific. Admin token, basic auth, SSO,
  mTLS-client-cert.

Every other engine concern stays inside the engine. The dispatcher
pipeline, the OpenAI schema validation, the worker-node HTTP client,
the payment-daemon gRPC client, the request lifecycle metrics — none
of those are operator-overridable. Forking the engine is permitted
under MIT but not encouraged; the adapter surface is meant to absorb
deployment-specific work without forking.

## Wallet

`Wallet` controls every cost decision. The engine asks the wallet
three things, in this order:

1. **Reserve** — before dispatching a request, "is this caller
   allowed to spend up to this much?"
2. **Commit** — after the worker returns, "actuals were this much;
   reconcile the reservation."
3. **Refund** — if the dispatch fails before commit, "the reservation
   never converted; release it."

```ts
import type {
  Wallet,
  CostQuote,
  UsageReport,
  ReservationHandle,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

interface Wallet {
  reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle | null>;
  commit(handle: ReservationHandle, usage: UsageReport): Promise<void>;
  refund(handle: ReservationHandle): Promise<void>;
}
```

The engine passes `callerId` (resolved from the AuthResolver) to
`reserve` only — `commit` and `refund` operate on the
`ReservationHandle` you returned. If your wallet needs caller
identity at commit time, encode it into the handle (see the
prepaid-USD example).

### Multi-unit cost

`CostQuote` and `UsageReport` carry the cost in three units:

```ts
interface CostQuote {
  workId: string;        // engine-internal idempotency key
  cents: bigint;         // USD cents (prepaid wallets read this)
  wei: bigint;           // ETH wei (crypto wallets read this)
  estimatedTokens: number; // free-tier wallets read this
  model: string;
  capability: NodeCapability;
  callerTier: string;    // opaque — wallet impl interprets
}
```

Pick the unit that matches your wallet's accounting and ignore the
others. The engine fills all three on every quote so the same
adapter shape covers prepaid / postpaid / crypto without union types.

### `null` from `reserve` semantics

A wallet returning `null` from `reserve` signals **postpaid: charge
on commit, no upfront authorization needed**. The engine treats this
as "go ahead and dispatch", calls `commit` with the actuals when the
worker returns, and skips `refund` entirely (nothing to release).

This is the right shape for B2B accounts billed monthly — the engine
records usage but doesn't gate.

A wallet that wants to **deny** the request returns a thrown
`BalanceInsufficientError` or `QuotaExceededError`, not `null`. The
engine maps both to a 402 response.

### Partial-commit semantics

`UsageReport.actualTokens` and `UsageReport.cents` may be smaller
than what the quote authorized — the worker delivered fewer tokens
than estimated, or only a subset of the requested image count. The
wallet is expected to:

- Charge the actual amount.
- Refund the difference between reservation and actual.
- Log the reservation as `committed` (not `partial`) — partial-vs-full
  is an engine concern (`usage_record.status`), not a wallet one.

### Refund-on-failure

If the dispatcher throws before reaching `commit` (worker returns
500, network timeout, payment failure), the engine calls `refund`
with the original `ReservationHandle`. The wallet should release
the reservation and not record any spend.

`refund` is best-effort — if it throws, the engine swallows the
error and surfaces the original failure to the caller. Don't rely
on `refund` for invariants; treat it as a hint.

### Pattern: postpaid B2B

```ts
const postpaidWallet: Wallet = {
  async reserve(_callerId, _quote) {
    return null; // no upfront authorization
  },
  async commit(_handle, _usage) {
    // Postpaid wallets typically pull callerId + workId from the
    // request context (closure / request-scoped wallet instance)
    // since reserve() returned null and the engine doesn't pass
    // them on commit. Record the spend against the operator's
    // ledger; the engine just confirmed actuals.
  },
  async refund(_handle) {
    // null reservations don't need refunding
  },
};
```

See `examples/wallets/postpaid.ts` for a runnable version.

### Pattern: prepaid USD

```ts
const prepaidWallet: Wallet = {
  async reserve(callerId, quote) {
    const balance = await getBalance(callerId);
    if (balance < quote.cents) {
      throw new BalanceInsufficientError(balance, quote.cents);
    }
    await db.insert('reservation', {
      id: quote.workId,
      callerId,
      cents: quote.cents.toString(),
      state: 'open',
    });
    await debitBalance(callerId, quote.cents);
    // Encode callerId into the handle so commit/refund can find it.
    return { id: quote.workId };
  },
  async commit(handle, usage) {
    const id = (handle as { id: string }).id;
    const r = await loadReservation(id);
    if (!r || r.state !== 'open') return;
    const refundCents = r.cents - usage.cents;
    if (refundCents > 0n) {
      await creditBalance(r.callerId, refundCents);
    }
    await markCommitted(id, usage.cents);
  },
  async refund(handle) {
    const id = (handle as { id: string }).id;
    const r = await loadReservation(id);
    if (!r || r.state !== 'open') return;
    await creditBalance(r.callerId, r.cents);
    await markRefunded(id);
  },
};
```

See `examples/wallets/prepaid-usd.ts`.

### Pattern: free-quota tokens

```ts
const freeQuotaWallet: Wallet = {
  async reserve(callerId, quote) {
    const remaining = await getRemainingTokens(callerId);
    if (remaining < quote.estimatedTokens) {
      throw new QuotaExceededError(BigInt(remaining), BigInt(quote.estimatedTokens));
    }
    await db.insert('reservation', {
      id: quote.workId,
      callerId,
      tokens: quote.estimatedTokens,
      state: 'open',
    });
    await decrementTokens(callerId, quote.estimatedTokens);
    return { id: quote.workId };
  },
  async commit(handle, usage) {
    const id = (handle as { id: string }).id;
    const r = await loadReservation(id);
    if (!r || r.state !== 'open') return;
    const refundTokens = r.tokens - usage.actualTokens;
    if (refundTokens > 0) {
      await incrementTokens(r.callerId, refundTokens);
    }
    await markCommitted(id, usage.actualTokens);
  },
  async refund(handle) {
    const id = (handle as { id: string }).id;
    const r = await loadReservation(id);
    if (!r || r.state !== 'open') return;
    await incrementTokens(r.callerId, r.tokens);
    await markRefunded(id);
  },
};
```

See `examples/wallets/free-quota.ts`.

## AuthResolver

`AuthResolver` turns an HTTP `Authorization` header into a generic
`Caller`. The engine treats every `Caller` field except `id` as
opaque — your impl decides what they mean.

```ts
interface AuthResolver {
  resolve(req: AuthResolverRequest): Promise<Caller | null>;
}

interface Caller {
  id: string;            // your unique identifier
  tier: string;          // opaque — passed to ServiceRegistry.select()
  rateLimitTier: string; // opaque — passed to RateLimiter.check()
  metadata?: unknown;    // your richer context — engine never inspects
}
```

Returning `null` signals "not authenticated"; the engine maps that
to a 401. Throwing a non-`AuthError` exception signals an internal
failure (treated as 500).

### Tier conventions

The default Cloud-SPE shell uses two billing tiers (`free` /
`prepaid`) and several rate-limit tiers (`free-default`,
`paid-starter`, `paid-pro`, ...). Your impl is free to use any
strings — the engine just threads them through to
`ServiceRegistryClient.select({ tier })` and `RateLimiter.check(id, tier)`.

`tier` and `rateLimitTier` are intentionally separate: a single
billing tier may map to many rate-limit tiers (e.g. all prepaid
customers are in the `prepaid` billing tier but might be on
`paid-starter` / `paid-pro` rate limits depending on their plan).

### Pattern: bearer token

```ts
const bearerResolver: AuthResolver = {
  async resolve(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    const account = await lookupAccountByToken(token);
    if (!account) return null;
    return {
      id: account.id,
      tier: account.tier,
      rateLimitTier: account.rateLimitTier,
      metadata: account, // shell uses this; engine never reads it
    };
  },
};
```

### Pattern: mTLS

```ts
const mtlsResolver: AuthResolver = {
  async resolve(req) {
    const cn = req.tlsClientCertCN; // however your edge surfaces it
    if (!cn) return null;
    const account = await lookupAccountByCN(cn);
    if (!account) return null;
    return { id: account.id, tier: account.tier, rateLimitTier: account.tier };
  },
};
```

### Pattern: header API key

```ts
const headerResolver: AuthResolver = {
  async resolve(req) {
    const key = req.headers['x-api-key'];
    if (!key) return null;
    const account = await lookupAccountByHashedKey(hashKey(key));
    if (!account) return null;
    return { id: account.id, tier: account.tier, rateLimitTier: account.tier };
  },
};
```

## RateLimiter

`RateLimiter` decides whether a caller may dispatch *now*. The engine
asks before every dispatch and again on the way out (so concurrency
limits work).

```ts
interface RateLimiter {
  check(callerId: string, tier: string): Promise<RateLimitResult>;
  release(concurrencyKey: string, failedOpen: boolean): Promise<void>;
}

interface RateLimitResult {
  concurrencyKey: string;
  failedOpen: boolean;
  headers: { limitRequests: number; remainingRequests: number; resetSeconds: number };
}
```

The default impl (`createRateLimiter`) is a Redis sliding-window
limiter with a tier→policy map. Operators with simpler needs can
implement an in-memory limiter; operators with more complex needs
(per-endpoint quotas, regional limits) can compose multiple
limiters behind this interface.

`failedOpen: true` means the limiter couldn't reach Redis but
allowed the request through — the engine surfaces this as a metric
so operators can detect ratelimit-bypass storms.

## Logger

`Logger` is a structured log sink. Five levels; structured context
as a second argument.

```ts
interface Logger {
  trace(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, errOrCtx?: Error | Record<string, unknown>): void;
}
```

The default `createConsoleLogger` writes JSON to stdout. Operators
who want pino, winston, or a vendor-specific logger wire it via
this interface — see `pino` integration example below.

### Pattern: pino

```ts
import pino from 'pino';
import type { Logger } from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

const pinoInstance = pino({ level: 'info' });

const pinoLogger: Logger = {
  trace: (msg, ctx) => pinoInstance.trace(ctx ?? {}, msg),
  debug: (msg, ctx) => pinoInstance.debug(ctx ?? {}, msg),
  info: (msg, ctx) => pinoInstance.info(ctx ?? {}, msg),
  warn: (msg, ctx) => pinoInstance.warn(ctx ?? {}, msg),
  error: (msg, errOrCtx) => {
    if (errOrCtx instanceof Error) {
      pinoInstance.error({ err: errOrCtx }, msg);
    } else {
      pinoInstance.error(errOrCtx ?? {}, msg);
    }
  },
};
```

## AdminAuthResolver

`AdminAuthResolver` controls access to the optional operator
dashboard at `/admin/ops` (and any custom admin routes you wire).

```ts
interface AdminAuthResolver {
  resolve(req: AdminAuthResolverRequest): Promise<{ actor: string } | null>;
}
```

Returning `null` triggers a 401 with `WWW-Authenticate: Basic`. The
`actor` field surfaces in audit logs so multi-operator deployments
can attribute admin actions.

The default `createBasicAdminAuthResolver` reads HTTP basic-auth
credentials from `BRIDGE_OPS_USER` / `BRIDGE_OPS_PASS` env vars —
sufficient for solo-operator deployments. SSO / SAML / mTLS
operators wire their own resolver.

## Non-adapter: `ServiceRegistryClient`

`ServiceRegistryClient` is **not** an operator-overridable adapter.
The engine commits to the
[`livepeer-modules-project/service-registry-daemon`](https://github.com/livepeer-modules-project/service-registry-daemon)
as the canonical source of WorkerNode discovery + selection.

The interface lives in the public package surface
(`@cloudspe/livepeer-gateway-core/providers/serviceRegistry.js`)
for two reasons:

- **Testability** — tests need to stub the registry to avoid
  spinning up a daemon. `examples/minimal-shell/` ships a static
  `createFakeServiceRegistry` for this.
- **Transparency** — operators who need to understand what calls
  the daemon makes can read the interface.

It is **not** a swap-out point. Operators with proprietary discovery
systems should:

- Run a `service-registry-daemon` instance that proxies to their
  system (the daemon is itself OSS and accepts contributions for
  new discovery backends).
- Or fork the engine if their constraints can't fit the
  daemon's discovery model.

The engine commits to this interface shape so that adopters who
deploy our reference stack get a known-working integration without
building their own gRPC client.

## See also

- [`examples/minimal-shell/`](../examples/minimal-shell/) — runnable
  end-to-end example wiring all five adapters with `InMemoryWallet`,
  a no-op AuthResolver, and `createFakeServiceRegistry`.
- [`examples/wallets/`](../examples/wallets/) — the three Wallet
  patterns above as standalone files.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to file an issue or
  PR proposing an adapter-contract change (which is breaking — the
  bar is high).
