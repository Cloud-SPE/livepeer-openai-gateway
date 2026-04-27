// Illustrative `Wallet` impl — POSTPAID B2B accounting.
// NOT production-ready. Records spend after the fact; never gates.
//
// Ship-shape adopters need: real persistence, monthly invoicing,
// dispute / chargeback handling, dunning. None of that is here.
//
// See docs/adapters.md → "Pattern: postpaid B2B" for the framing.

import type {
  Caller,
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
  return {
    async reserve(_caller: Caller, _quote: CostQuote): Promise<ReservationHandle | null> {
      // Postpaid accounts: no upfront authorization. The engine
      // dispatches and calls commit() with actuals.
      return null;
    },

    async commit(caller: Caller, _handle: ReservationHandle, usage: UsageReport): Promise<void> {
      await deps.store.recordUsage({
        callerId: caller.id,
        workId: '', // reservation never opened — engine doesn't pass quote.workId here
        cents: usage.cents,
        actualTokens: usage.actualTokens,
        model: usage.model,
        capability: usage.capability,
      });
    },

    async refund(): Promise<void> {
      // null reservations don't need refunding — nothing was held.
    },
  };
}
