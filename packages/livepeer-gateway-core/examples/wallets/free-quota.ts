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
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

interface QuotaReservation {
  id: string;
  callerId: string;
  tokens: number;
  state: 'open' | 'committed' | 'refunded';
}

export function createFreeQuotaWallet(): Wallet & {
  seedAllowance(callerId: string, tokens: number): void;
} {
  const remainingTokens = new Map<string, number>();
  const reservations = new Map<string, QuotaReservation>();

  const wallet: Wallet = {
    async reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle> {
      const remaining = remainingTokens.get(callerId) ?? 0;
      if (remaining < quote.estimatedTokens) {
        throw new QuotaExceededError(BigInt(remaining), BigInt(quote.estimatedTokens));
      }
      remainingTokens.set(callerId, remaining - quote.estimatedTokens);
      reservations.set(quote.workId, {
        id: quote.workId,
        callerId,
        tokens: quote.estimatedTokens,
        state: 'open',
      });
      return { id: quote.workId };
    },

    async commit(handle: ReservationHandle, usage: UsageReport): Promise<void> {
      const id = (handle as { id: string }).id;
      const r = reservations.get(id);
      if (!r || r.state !== 'open') return;
      const refundTokens = r.tokens - usage.actualTokens;
      if (refundTokens > 0) {
        const remaining = remainingTokens.get(r.callerId) ?? 0;
        remainingTokens.set(r.callerId, remaining + refundTokens);
      }
      reservations.set(id, { ...r, state: 'committed' });
    },

    async refund(handle: ReservationHandle): Promise<void> {
      const id = (handle as { id: string }).id;
      const r = reservations.get(id);
      if (!r || r.state !== 'open') return;
      const remaining = remainingTokens.get(r.callerId) ?? 0;
      remainingTokens.set(r.callerId, remaining + r.tokens);
      reservations.set(id, { ...r, state: 'refunded' });
    },
  };

  return Object.assign(wallet, {
    seedAllowance(callerId: string, tokens: number): void {
      remainingTokens.set(callerId, tokens);
    },
  });
}
