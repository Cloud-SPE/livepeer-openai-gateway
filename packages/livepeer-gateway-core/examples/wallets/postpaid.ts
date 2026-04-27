// Illustrative `Wallet` impl — POSTPAID B2B accounting.
// NOT production-ready. Records spend after the fact; never gates.
//
// Ship-shape adopters need: real persistence, monthly invoicing,
// dispute / chargeback handling, dunning. None of that is here.
//
// See docs/adapters.md → "Pattern: postpaid B2B" for the framing.

import type {
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

interface PostpaidStore {
  recordUsage(input: {
    callerId: string;
    workId: string;
    cents: bigint;
    actualTokens: number;
    model: string;
    capability: string;
  }): Promise<void>;
}

export interface PostpaidWalletDeps {
  store: PostpaidStore;
}

export function createPostpaidWallet(deps: PostpaidWalletDeps): Wallet {
  // Postpaid pattern needs the workId (the engine's idempotency key)
  // at commit time so each reservation handle carries it forward.
  // Store callerId + workId on the handle since reserve() returns
  // null but commit() runs against the engine's reserved state.
  const pending = new Map<string, { callerId: string; workId: string }>();

  return {
    async reserve(_callerId: string, _quote: CostQuote): Promise<ReservationHandle | null> {
      // Postpaid accounts: no upfront authorization. Engine dispatches
      // and calls commit() with the actuals later.
      return null;
    },

    async commit(_handle: ReservationHandle, usage: UsageReport): Promise<void> {
      // The engine passed null from reserve(), so handle is null here.
      // Postpaid wallets typically pull callerId + workId from the
      // request context via a closure or a request-scoped wallet
      // instance — not from the handle. This stub assumes it's
      // accessible via `pending` (populated by an upstream hook in
      // the operator's middleware).
      const ctx = pending.values().next().value;
      if (!ctx) return;
      pending.delete(ctx.workId);
      await deps.store.recordUsage({
        callerId: ctx.callerId,
        workId: ctx.workId,
        cents: usage.cents,
        actualTokens: usage.actualTokens,
        model: usage.model,
        capability: usage.capability,
      });
    },

    async refund(_handle: ReservationHandle): Promise<void> {
      // null reservations don't need refunding — nothing was held.
    },
  };
}
