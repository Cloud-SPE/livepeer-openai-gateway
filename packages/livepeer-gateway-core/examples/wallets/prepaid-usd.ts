// Illustrative `Wallet` impl — PREPAID USD balance.
// NOT production-ready. In-memory state; not concurrency-safe; no
// audit trail; no top-up flow.
//
// Ship-shape adopters need: row-level locks (or transactional
// updates), idempotency on workId, ledger entries for every motion
// for audit, integration with a payments provider for top-ups.
//
// See docs/adapters.md → "Pattern: prepaid USD" for the framing.

import { BalanceInsufficientError } from '@cloudspe/livepeer-gateway-core/service/billing/errors.js';
import type {
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

interface Reservation {
  id: string;
  callerId: string;
  workId: string;
  cents: bigint;
  state: 'open' | 'committed' | 'refunded';
}

export function createPrepaidUsdWallet(): Wallet & {
  seedBalance(callerId: string, cents: bigint): void;
} {
  const balances = new Map<string, bigint>();
  const reservations = new Map<string, Reservation>();

  const wallet: Wallet = {
    async reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle> {
      const balance = balances.get(callerId) ?? 0n;
      if (balance < quote.cents) {
        throw new BalanceInsufficientError(balance, quote.cents);
      }
      balances.set(callerId, balance - quote.cents);
      reservations.set(quote.workId, {
        id: quote.workId,
        callerId,
        workId: quote.workId,
        cents: quote.cents,
        state: 'open',
      });
      return { id: quote.workId };
    },

    async commit(handle: ReservationHandle, usage: UsageReport): Promise<void> {
      const id = (handle as { id: string }).id;
      const r = reservations.get(id);
      if (!r || r.state !== 'open') return;
      const refundCents = r.cents - usage.cents;
      if (refundCents > 0n) {
        const balance = balances.get(r.callerId) ?? 0n;
        balances.set(r.callerId, balance + refundCents);
      }
      reservations.set(id, { ...r, state: 'committed' });
    },

    async refund(handle: ReservationHandle): Promise<void> {
      const id = (handle as { id: string }).id;
      const r = reservations.get(id);
      if (!r || r.state !== 'open') return;
      const balance = balances.get(r.callerId) ?? 0n;
      balances.set(r.callerId, balance + r.cents);
      reservations.set(id, { ...r, state: 'refunded' });
    },
  };

  return Object.assign(wallet, {
    seedBalance(callerId: string, cents: bigint): void {
      balances.set(callerId, cents);
    },
  });
}
