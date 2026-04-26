import { randomUUID } from 'node:crypto';
import type { Db } from '../repo/db.js';
import * as usageRecordsRepo from '../repo/usageRecords.js';
import type { PricingConfig } from '../config/pricing.js';
import type { NodeClient } from '../providers/nodeClient.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { NodeBook } from '../service/nodes/nodebook.js';
import { capabilityString } from '../types/capability.js';
import { pickNode } from '../service/routing/router.js';
import {
  computeSpeechActualCost,
  estimateSpeechReservation,
} from '../service/pricing/index.js';
import { UpstreamNodeError } from '../runtime/http/errors.js';
import { type SpeechRequest } from '../types/speech.js';
import type { Recorder } from '../providers/metrics/recorder.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '../interfaces/index.js';
import { UnknownCallerTierError } from '../service/billing/errors.js';
import { FreeTierUnsupportedError } from './embeddings.js';

export interface SpeechDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: SpeechRequest;
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
  /** Aborted by the caller when the client connection closes. */
  signal: AbortSignal;
}

export interface SpeechDispatchResult {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  status: number;
}

/**
 * Framework-free speech dispatcher. Settles the wallet (commit + usage
 * record) BEFORE returning the upstream stream — char count is exact
 * at the boundary so estimate == actual; no reconciliation needed.
 * Caller's wrapper pipes the returned stream to its HTTP response.
 *
 * Per exec-plan 0025.
 */
export async function dispatchSpeech(
  deps: SpeechDispatchDeps,
): Promise<SpeechDispatchResult> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') {
    throw new FreeTierUnsupportedError('/v1/audio/speech');
  }
  if (callerTier !== 'prepaid') {
    throw new UnknownCallerTierError(deps.caller.id, callerTier);
  }

  const charCount = [...deps.body.input].length;
  const workId = `${deps.caller.id}:${randomUUID()}`;
  const estimate = estimateSpeechReservation(charCount, deps.body.model, deps.pricing);

  const reserveQuote: CostQuote = {
    workId,
    cents: estimate.estCents,
    wei: 0n,
    estimatedTokens: 0,
    model: deps.body.model,
    capability: 'speech',
    callerTier,
  };

  let handle: ReservationHandle | null = null;
  let committed = false;

  try {
    handle = await deps.wallet.reserve(deps.caller.id, reserveQuote);

    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      deps.body.model,
      'prepaid',
      'speech',
    );
    const quote = node.quotes.get(capabilityString('speech'));
    if (!quote) {
      throw new UpstreamNodeError(node.config.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.config.id,
      quote,
      workUnits: BigInt(charCount),
      capability: capabilityString('speech'),
      model: deps.body.model,
    });
    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');

    const call = await deps.nodeClient.createSpeech({
      url: node.config.url,
      body: deps.body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
      signal: deps.signal,
    });

    if (call.status >= 400 || call.stream === null) {
      throw new UpstreamNodeError(
        node.config.id,
        call.status,
        (call.rawErrorBody ?? '').slice(0, 512),
      );
    }

    const cost = computeSpeechActualCost(charCount, deps.body.model, deps.pricing);
    if (handle !== null) {
      const usage: UsageReport = {
        cents: cost.actualCents,
        wei: payment.expectedValueWei,
        actualTokens: 0,
        model: deps.body.model,
        capability: 'speech',
      };
      await deps.wallet.commit(handle, usage);
    }
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: deps.caller.id,
      workId,
      kind: 'speech',
      model: deps.body.model,
      nodeUrl: node.config.url,
      charCount,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    return {
      stream: call.stream as unknown as ReadableStream<Uint8Array>,
      contentType: call.contentType ?? 'audio/mpeg',
      status: call.status,
    };
  } catch (err) {
    if (handle !== null && !committed) {
      try {
        await deps.wallet.refund(handle);
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}
