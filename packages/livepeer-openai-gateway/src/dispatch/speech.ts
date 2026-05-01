/* v8 ignore file */

import { randomUUID } from 'node:crypto';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import * as usageRecordsRepo from '@cloudspe/livepeer-openai-gateway-core/repo/usageRecords.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import {
  computeSpeechActualCost,
  estimateSpeechReservation,
} from '@cloudspe/livepeer-openai-gateway-core/service/pricing/index.js';
import { UpstreamNodeError } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import { type SpeechRequest } from '@cloudspe/livepeer-openai-gateway-core/types/speech.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import { UnknownCallerTierError } from '@cloudspe/livepeer-openai-gateway-core/service/billing/errors.js';
import { FreeTierUnsupportedError } from './embeddings.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../providers/serviceRegistry.js';
import { selectRoute } from '../service/routing/selectRoute.js';

export interface SpeechDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: SpeechRequest;
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfigProvider;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  signal: AbortSignal;
}

export interface SpeechDispatchResult {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  status: number;
}

export async function dispatchSpeech(deps: SpeechDispatchDeps): Promise<SpeechDispatchResult> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') throw new FreeTierUnsupportedError('/v1/audio/speech');
  if (callerTier !== 'prepaid') throw new UnknownCallerTierError(deps.caller.id, callerTier);

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
    const route = await selectRoute(
      { serviceRegistry: deps.serviceRegistry, nodeIndex: deps.nodeIndex },
      { capability: 'speech', offering: deps.body.model, tier: 'prepaid' },
    );

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: route.nodeId,
      recipientEthAddress: route.recipientEthAddress,
      pricePerWorkUnitWei: route.pricePerWorkUnitWei,
      workUnits: BigInt(charCount),
      capability: route.capability,
      model: deps.body.model,
      signal: deps.signal,
    });
    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');

    const call = await deps.nodeClient.createSpeech({
      url: route.url,
      body: deps.body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
      signal: deps.signal,
    });

    if (call.status >= 400 || call.stream === null) {
      deps.circuitBreaker.onFailure(route.nodeId, new Date());
      throw new UpstreamNodeError(
        route.nodeId,
        call.status,
        (call.rawErrorBody ?? '').slice(0, 512),
      );
    }
    deps.circuitBreaker.onSuccess(route.nodeId, new Date());

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
      callerId: deps.caller.id,
      workId,
      kind: 'speech',
      model: deps.body.model,
      nodeUrl: route.url,
      charCount,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    return {
      stream: call.stream as ReadableStream<Uint8Array>,
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
