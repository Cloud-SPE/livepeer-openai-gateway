import type { Db } from '../../repo/db.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import type {
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import { UnknownCallerTierError } from '@cloudspe/livepeer-openai-gateway-core/service/billing/errors.js';
import {
  commit,
  commitQuota,
  refund,
  refundQuota,
  reserve,
  reserveQuota,
} from './reservations.js';

/**
 * Default `Wallet` implementation that wraps the existing prepaid/free
 * billing flow in `reservations.ts`. Branches on `quote.callerTier`:
 *   - `prepaid` → cents-denominated reserve/commit/refund against the
 *     customer balance.
 *   - `free` → token-quota reserve/commit/refund against the monthly
 *     allowance.
 *
 * The handle is opaque from the engine's perspective; this impl uses
 * `{kind, reservationId}` so commit/refund know which branch to dispatch.
 *
 * Locked-in by exec-plan 0024. Stage-3 (workspace split) relocates this
 * file to the shell package; the engine ships an in-memory reference impl
 * for tests + examples.
 */
export interface PrepaidQuotaWalletDeps {
  db: Db;
  /** Optional metrics recorder; passed through to `commit` for the
   * revenue counter. */
  recorder?: Recorder;
}

interface PrepaidHandle {
  kind: 'prepaid';
  reservationId: string;
}

interface QuotaHandle {
  kind: 'quota';
  reservationId: string;
}

type Handle = PrepaidHandle | QuotaHandle;

export function createPrepaidQuotaWallet(deps: PrepaidQuotaWalletDeps): Wallet {
  return {
    async reserve(callerId: string, quote: CostQuote): Promise<ReservationHandle | null> {
      if (quote.callerTier === 'prepaid') {
        const result = await reserve(deps.db, {
          customerId: callerId,
          workId: quote.workId,
          estCostCents: quote.cents,
        });
        const handle: PrepaidHandle = { kind: 'prepaid', reservationId: result.reservationId };
        return handle;
      }
      if (quote.callerTier === 'free') {
        const result = await reserveQuota(deps.db, {
          customerId: callerId,
          workId: quote.workId,
          estTokens: BigInt(quote.estimatedTokens),
        });
        const handle: QuotaHandle = { kind: 'quota', reservationId: result.reservationId };
        return handle;
      }
      throw new UnknownCallerTierError(callerId, quote.callerTier);
    },

    async commit(handle: ReservationHandle, usage: UsageReport): Promise<void> {
      const h = handle as Handle;
      if (h.kind === 'prepaid') {
        await commit(
          deps.db,
          {
            reservationId: h.reservationId,
            actualCostCents: usage.cents,
            capability: usage.capability,
            model: usage.model,
            tier: 'prepaid',
          },
          deps.recorder,
        );
        return;
      }
      await commitQuota(deps.db, {
        reservationId: h.reservationId,
        actualTokens: BigInt(usage.actualTokens),
      });
    },

    async refund(handle: ReservationHandle): Promise<void> {
      const h = handle as Handle;
      if (h.kind === 'prepaid') {
        await refund(deps.db, h.reservationId);
        return;
      }
      await refundQuota(deps.db, h.reservationId);
    },
  };
}
