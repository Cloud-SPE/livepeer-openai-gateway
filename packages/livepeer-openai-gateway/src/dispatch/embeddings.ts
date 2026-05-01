import { randomUUID } from 'node:crypto';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import * as usageRecordsRepo from '@cloudspe/livepeer-openai-gateway-core/repo/usageRecords.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import {
  computeEmbeddingsActualCost,
  estimateEmbeddingsReservation,
} from '@cloudspe/livepeer-openai-gateway-core/service/pricing/index.js';
import {
  MissingUsageError,
  UpstreamNodeError,
} from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import {
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  normalizeEmbeddingsInput,
} from '@cloudspe/livepeer-openai-gateway-core/types/embeddings.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import { UnknownCallerTierError } from '@cloudspe/livepeer-openai-gateway-core/service/billing/errors.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../providers/serviceRegistry.js';
import { selectRoute } from '../service/routing/selectRoute.js';

export interface EmbeddingsDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: EmbeddingsRequest;
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfigProvider;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
}

export async function dispatchEmbeddings(
  deps: EmbeddingsDispatchDeps,
): Promise<EmbeddingsResponse> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') throw new FreeTierUnsupportedError('/v1/embeddings');
  if (callerTier !== 'prepaid') throw new UnknownCallerTierError(deps.caller.id, callerTier);

  const inputs = normalizeEmbeddingsInput(deps.body.input);
  const workId = `${deps.caller.id}:${randomUUID()}`;
  const estimate = estimateEmbeddingsReservation(inputs, deps.body.model, deps.pricing);

  const reserveQuote: CostQuote = {
    workId,
    cents: estimate.estCents,
    wei: 0n,
    estimatedTokens: estimate.promptEstimateTokens,
    model: deps.body.model,
    capability: 'embeddings',
    callerTier,
  };

  let handle: ReservationHandle | null = null;
  let committed = false;

  try {
    handle = await deps.wallet.reserve(deps.caller.id, reserveQuote);

    const route = await selectRoute(
      { serviceRegistry: deps.serviceRegistry, nodeIndex: deps.nodeIndex },
      { capability: 'embeddings', offering: deps.body.model, tier: 'prepaid' },
    );

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: route.nodeId,
      recipientEthAddress: route.recipientEthAddress,
      pricePerWorkUnitWei: route.pricePerWorkUnitWei,
      workUnits: BigInt(estimate.promptEstimateTokens),
      capability: route.capability,
      offering: route.offering,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createEmbeddings({
      url: route.url,
      body: deps.body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
    });

    if (call.status >= 400 || call.response === null) {
      deps.circuitBreaker.onFailure(route.nodeId, new Date());
      throw new UpstreamNodeError(route.nodeId, call.status, call.rawBody.slice(0, 512));
    }
    deps.circuitBreaker.onSuccess(route.nodeId, new Date());

    const response = call.response;
    if (!response.usage || typeof response.usage.prompt_tokens !== 'number') {
      throw new MissingUsageError(route.nodeId);
    }
    if (response.data.length !== inputs.length) {
      throw new UpstreamNodeError(
        route.nodeId,
        200,
        `data.length (${response.data.length}) !== input.length (${inputs.length})`,
      );
    }
    if (deps.body.dimensions !== undefined) {
      for (const entry of response.data) {
        if (Array.isArray(entry.embedding) && entry.embedding.length !== deps.body.dimensions) {
          throw new UpstreamNodeError(
            route.nodeId,
            200,
            `vector length ${entry.embedding.length} !== requested dimensions ${deps.body.dimensions}`,
          );
        }
      }
    }

    const cost = computeEmbeddingsActualCost(
      response.usage.prompt_tokens,
      deps.body.model,
      deps.pricing,
    );

    if (handle !== null) {
      const usage: UsageReport = {
        cents: cost.actualCents,
        wei: payment.expectedValueWei,
        actualTokens: response.usage.prompt_tokens,
        model: deps.body.model,
        capability: 'embeddings',
      };
      await deps.wallet.commit(handle, usage);
    }
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      callerId: deps.caller.id,
      workId,
      kind: 'embeddings',
      model: deps.body.model,
      nodeUrl: route.url,
      promptTokensReported: response.usage.prompt_tokens,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    return response;
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

export class FreeTierUnsupportedError extends Error {
  constructor(public readonly endpoint: string) {
    super(`${endpoint} is not available on the free tier`);
    this.name = 'FreeTierUnsupportedError';
  }
}
