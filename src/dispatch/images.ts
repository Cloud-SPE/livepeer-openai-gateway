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
  computeImagesActualCost,
  estimateImagesReservation,
} from '../service/pricing/index.js';
import { MissingUsageError, UpstreamNodeError } from '../runtime/http/errors.js';
import {
  IMAGES_DEFAULT_N,
  IMAGES_DEFAULT_QUALITY,
  IMAGES_DEFAULT_RESPONSE_FORMAT,
  IMAGES_DEFAULT_SIZE,
  type ImagesGenerationRequest,
  type ImagesResponse,
} from '../types/images.js';
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

export interface ImagesDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ImagesGenerationRequest;
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

export async function dispatchImages(
  deps: ImagesDispatchDeps,
): Promise<ImagesResponse> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') {
    throw new FreeTierUnsupportedError('/v1/images/generations');
  }
  if (callerTier !== 'prepaid') {
    throw new UnknownCallerTierError(deps.caller.id, callerTier);
  }

  const n = deps.body.n ?? IMAGES_DEFAULT_N;
  const size = deps.body.size ?? IMAGES_DEFAULT_SIZE;
  const quality = deps.body.quality ?? IMAGES_DEFAULT_QUALITY;
  const responseFormat = deps.body.response_format ?? IMAGES_DEFAULT_RESPONSE_FORMAT;
  const workId = `${deps.caller.id}:${randomUUID()}`;
  const estimate = estimateImagesReservation(n, deps.body.model, size, quality, deps.pricing);

  const reserveQuote: CostQuote = {
    workId,
    cents: estimate.estCents,
    wei: 0n,
    estimatedTokens: 0,
    model: deps.body.model,
    capability: 'images',
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
      { capability: 'images', model: deps.body.model, tier: 'prepaid' },
    );
    const quote = deps.quoteCache.get(node.id, capabilityString('images'));
    if (!quote) {
      throw new UpstreamNodeError(node.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.id,
      quote,
      workUnits: BigInt(n),
      capability: capabilityString('images'),
      model: deps.body.model,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createImage({
      url: node.url,
      body: deps.body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
    });

    if (call.status >= 400 || call.response === null) {
      throw new UpstreamNodeError(node.id, call.status, call.rawBody.slice(0, 512));
    }

    const response = call.response;
    const returnedCount = response.data.length;

    if (returnedCount === 0) {
      throw new MissingUsageError(node.id);
    }
    if (returnedCount > n) {
      throw new UpstreamNodeError(
        node.id,
        200,
        `node returned ${returnedCount} images for n=${n}`,
      );
    }
    for (const entry of response.data) {
      if (responseFormat === 'url' && !entry.url) {
        throw new UpstreamNodeError(node.id, 200, 'response_format=url but url missing');
      }
      if (responseFormat === 'b64_json' && !entry.b64_json) {
        throw new UpstreamNodeError(
          node.id,
          200,
          'response_format=b64_json but b64_json missing',
        );
      }
    }

    const cost = computeImagesActualCost(returnedCount, deps.body.model, size, quality, deps.pricing);
    const status = returnedCount < n ? 'partial' : 'success';

    if (handle !== null) {
      const usage: UsageReport = {
        cents: cost.actualCents,
        wei: payment.expectedValueWei,
        actualTokens: 0,
        model: deps.body.model,
        capability: 'images',
      };
      await deps.wallet.commit(handle, usage);
    }
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: deps.caller.id,
      workId,
      kind: 'images',
      model: deps.body.model,
      nodeUrl: node.url,
      imageCount: returnedCount,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status,
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
