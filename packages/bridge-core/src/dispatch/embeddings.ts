import { randomUUID } from 'node:crypto';
import type { Db } from '../repo/db.js';
import * as usageRecordsRepo from '../repo/usageRecords.js';
import type { PricingConfig } from '../config/pricing.js';
import type { NodeClient } from '../providers/nodeClient.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../providers/serviceRegistry.js';
import type { CircuitBreaker } from '../service/routing/circuitBreaker.js';
import type { QuoteCache } from '../service/routing/quoteCache.js';
import { capabilityString } from '../types/capability.js';
import { selectNode } from '../service/routing/router.js';
import {
  computeEmbeddingsActualCost,
  estimateEmbeddingsReservation,
} from '../service/pricing/index.js';
import { MissingUsageError, UpstreamNodeError } from '../runtime/http/errors.js';
import {
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  normalizeEmbeddingsInput,
} from '../types/embeddings.js';
import type { Recorder } from '../providers/metrics/recorder.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '../interfaces/index.js';
import { UnknownCallerTierError } from '../service/billing/errors.js';

export interface EmbeddingsDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: EmbeddingsRequest;
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  quoteCache: QuoteCache;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

/**
 * Framework-free embeddings dispatcher. Free tier rejection happens
 * inside the dispatcher; the wrapper translates the resulting
 * `FreeTierUnsupportedError` to a 402 response.
 *
 * Per exec-plan 0025.
 */
export async function dispatchEmbeddings(
  deps: EmbeddingsDispatchDeps,
): Promise<EmbeddingsResponse> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') {
    throw new FreeTierUnsupportedError('/v1/embeddings');
  }
  if (callerTier !== 'prepaid') {
    throw new UnknownCallerTierError(deps.caller.id, callerTier);
  }

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

    const node = await selectNode(
      {
        serviceRegistry: deps.serviceRegistry,
        circuitBreaker: deps.circuitBreaker,
        ...(deps.rng ? { rng: deps.rng } : {}),
      },
      { capability: 'embeddings', model: deps.body.model, tier: 'prepaid' },
    );
    const quote = deps.quoteCache.get(node.id, capabilityString('embeddings'));
    if (!quote) {
      throw new UpstreamNodeError(node.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.id,
      quote,
      workUnits: BigInt(estimate.promptEstimateTokens),
      capability: capabilityString('embeddings'),
      model: deps.body.model,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createEmbeddings({
      url: node.url,
      body: deps.body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
    });

    if (call.status >= 400 || call.response === null) {
      throw new UpstreamNodeError(node.id, call.status, call.rawBody.slice(0, 512));
    }

    const response = call.response;
    if (!response.usage || typeof response.usage.prompt_tokens !== 'number') {
      throw new MissingUsageError(node.id);
    }
    if (response.data.length !== inputs.length) {
      throw new UpstreamNodeError(
        node.id,
        200,
        `data.length (${response.data.length}) !== input.length (${inputs.length})`,
      );
    }
    if (deps.body.dimensions !== undefined) {
      for (const entry of response.data) {
        if (Array.isArray(entry.embedding) && entry.embedding.length !== deps.body.dimensions) {
          throw new UpstreamNodeError(
            node.id,
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
      nodeUrl: node.url,
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

/** Thrown by dispatchers when a free-tier caller hits a paid-only endpoint. */
export class FreeTierUnsupportedError extends Error {
  constructor(public readonly endpoint: string) {
    super(`${endpoint} is not available on the free tier`);
    this.name = 'FreeTierUnsupportedError';
  }
}
