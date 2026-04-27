# Wallet examples

Three illustrative `Wallet` impls. **Each is illustrative — not
production-ready.** They exist to show what shape a Wallet takes for
the three most common deployment patterns.

| File | Pattern | When to start here |
|------|---------|---------------------|
| [`postpaid.ts`](./postpaid.ts) | Postpaid B2B accounting | Monthly-invoiced enterprise customers; charge after usage; never gate. |
| [`prepaid-usd.ts`](./prepaid-usd.ts) | Prepaid USD balance | Self-serve customers top up a balance; engine debits on reserve, refunds delta on commit. |
| [`free-quota.ts`](./free-quota.ts) | Free-tier token quota | Free-tier or open-beta tier with monthly token allowance. |

## What's missing in these stubs

Each stub is ~50 lines and uses in-memory state. To make any of them
production-ready you'll need:

- **Persistence** — replace the `Map`s with a real database (Postgres
  is the engine's reference, but the Wallet adapter doesn't care).
- **Concurrency safety** — wrap the reserve / commit / refund paths
  in transactions or row-level locks. The in-memory versions are
  not safe under concurrent dispatches for the same caller.
- **Idempotency** — `quote.workId` is the engine's idempotency key.
  A real Wallet should treat `reserve(workId)` calls with the same
  workId as no-ops if a reservation already exists.
- **Audit trail** — record every motion (reserve / commit / refund)
  to a ledger so disputes are traceable. The in-memory versions just
  flip a `state` field.
- **Top-up / billing integration** — `prepaid-usd.ts` doesn't ship
  with a Stripe integration; the gateway shell
  (`livepeer-openai-gateway`) does that as a separate concern.
- **Quota reset cron** — `free-quota.ts` doesn't ship with monthly
  rollover. A real impl needs a scheduled job that re-credits the
  allowance.
- **Tier handling** — these stubs ignore `caller.tier`. A real impl
  may want different policies per tier (`free` quota tier vs.
  `prepaid` USD tier vs. an enterprise postpaid tier).

## See also

- [`docs/adapters.md`](../../docs/adapters.md) — the long-form adapter
  guide that frames why these patterns exist and how the engine
  consumes them.
- The reference shell in
  [`livepeer-openai-gateway`](https://github.com/Cloud-SPE/livepeer-openai-gateway)
  ships `createPrepaidQuotaWallet` — a real prepaid-USD + free-quota
  hybrid Wallet backed by Postgres + Stripe top-ups. Read it for a
  worked example of the patterns above.
