// Illustrative `Wallet` impl — FREE-TIER token quota.
// NOT production-ready. In-memory state; no monthly reset cron; no
// per-model quota distinction; no abuse detection.
//
// Ship-shape adopters need: persistent token-allowance tracking,
// quota-reset scheduling (monthly, daily, etc.), per-model or
// per-capability sub-quotas if free-tier limits vary by endpoint,
// abuse signals (multiple accounts from same IP, etc.).
//
// See docs/adapters.md → "Pattern: free-quota tokens" for the framing.

import { QuotaExceededError } from '@cloudspe/livepeer-gateway-core/service/billing/errors.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

interface QuotaReservation {
  callerId: string;
  tokens: number;
  state: 'open' | 'committed' | 'refunded';
}

export function createFreeQuotaWallet(): Wallet {
  const remainingTokens = new Map<string, number>();
  const reservations = new Map<string, QuotaReservation>();

  return {
    async reserve(caller: Caller, quote: CostQuote): Promise<ReservationHandle> {
      const remaining = remainingTokens.get(caller.id) ?? 0;
      if (remaining < quote.estimatedTokens) {
        throw new QuotaExceededError(BigInt(remaining), BigInt(quote.estimatedTokens));
      }
      remainingTokens.set(caller.id, remaining - quote.estimatedTokens);
      reservations.set(quote.workId, {
        callerId: caller.id,
        tokens: quote.estimatedTokens,
        state: 'open',
      });
      return quote.workId;
    },

    async commit(caller: Caller, handle: ReservationHandle, usage: UsageReport): Promise<void> {
      const r = reservations.get(handle as string);
      if (!r || r.state !== 'open') return;
      const refundTokens = r.tokens - usage.actualTokens;
      if (refundTokens > 0) {
        const remaining = remainingTokens.get(caller.id) ?? 0;
        remainingTokens.set(caller.id, remaining + refundTokens);
      }
      reservations.set(handle as string, { ...r, state: 'committed' });
    },

    async refund(caller: Caller, handle: ReservationHandle): Promise<void> {
      const r = reservations.get(handle as string);
      if (!r || r.state !== 'open') return;
      const remaining = remainingTokens.get(caller.id) ?? 0;
      remainingTokens.set(caller.id, remaining + r.tokens);
      reservations.set(handle as string, { ...r, state: 'refunded' });
    },
  };
}

export function seedAllowance(wallet: Wallet, callerId: string, tokens: number): void {
  // Test affordance — credit a starting allowance. Real impls reset
  // monthly via a cron / scheduled job.
  const internal = wallet as unknown as { remainingTokens?: Map<string, number> };
  if (internal.remainingTokens) internal.remainingTokens.set(callerId, tokens);
}
