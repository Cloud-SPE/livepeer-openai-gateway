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
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

interface Reservation {
  callerId: string;
  workId: string;
  cents: bigint;
  state: 'open' | 'committed' | 'refunded';
}

export function createPrepaidUsdWallet(): Wallet {
  const balances = new Map<string, bigint>();
  const reservations = new Map<string, Reservation>();

  return {
    async reserve(caller: Caller, quote: CostQuote): Promise<ReservationHandle> {
      const balance = balances.get(caller.id) ?? 0n;
      if (balance < quote.cents) {
        throw new BalanceInsufficientError(balance, quote.cents);
      }
      balances.set(caller.id, balance - quote.cents);
      reservations.set(quote.workId, {
        callerId: caller.id,
        workId: quote.workId,
        cents: quote.cents,
        state: 'open',
      });
      return quote.workId;
    },

    async commit(caller: Caller, handle: ReservationHandle, usage: UsageReport): Promise<void> {
      const r = reservations.get(handle as string);
      if (!r || r.state !== 'open') return;
      const refundCents = r.cents - usage.cents;
      if (refundCents > 0n) {
        const balance = balances.get(caller.id) ?? 0n;
        balances.set(caller.id, balance + refundCents);
      }
      reservations.set(handle as string, { ...r, state: 'committed' });
    },

    async refund(caller: Caller, handle: ReservationHandle): Promise<void> {
      const r = reservations.get(handle as string);
      if (!r || r.state !== 'open') return;
      const balance = balances.get(caller.id) ?? 0n;
      balances.set(caller.id, balance + r.cents);
      reservations.set(handle as string, { ...r, state: 'refunded' });
    },
  };
}

export function seedBalance(wallet: Wallet, callerId: string, cents: bigint): void {
  // Test affordance — reach into the wallet to credit a starting
  // balance. Real impls expose a top-up API instead.
  const internal = wallet as unknown as { balances?: Map<string, bigint> };
  if (internal.balances) internal.balances.set(callerId, cents);
}
