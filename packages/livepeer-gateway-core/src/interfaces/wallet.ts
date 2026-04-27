import type { CostQuote, ReservationHandle, UsageReport } from './caller.js';

/**
 * Operator-overridable adapter. The engine drives the request lifecycle
 * (reserve → commit OR reserve → refund); the operator decides what those
 * operations mean against their billing/quota/postpaid model.
 *
 * - `reserve` returning `null` means "no reservation needed" (postpaid
 *   pattern). The engine treats null handles as no-ops on commit/refund.
 * - `refund` is best-effort: if it throws, the engine swallows the error
 *   and surfaces the original failure to the caller.
 *
 * Locked-in by exec-plan 0024.
 */
export interface Wallet {
  reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle | null>;
  commit(handle: ReservationHandle, usage: UsageReport): Promise<void>;
  refund(handle: ReservationHandle): Promise<void>;
}
