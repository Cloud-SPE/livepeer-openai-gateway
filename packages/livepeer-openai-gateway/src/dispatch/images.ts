import { randomUUID } from 'node:crypto';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import * as usageRecordsRepo from '@cloudspe/livepeer-openai-gateway-core/repo/usageRecords.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import {
  computeImagesActualCost,
  estimateImagesReservation,
} from '@cloudspe/livepeer-openai-gateway-core/service/pricing/index.js';
import {
  MissingUsageError,
  UpstreamNodeError,
} from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import {
  IMAGES_DEFAULT_N,
  IMAGES_DEFAULT_QUALITY,
  IMAGES_DEFAULT_RESPONSE_FORMAT,
  IMAGES_DEFAULT_SIZE,
  type ImagesGenerationRequest,
  type ImagesResponse,
} from '@cloudspe/livepeer-openai-gateway-core/types/images.js';
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

export interface ImagesDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ImagesGenerationRequest;
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

export async function dispatchImages(deps: ImagesDispatchDeps): Promise<ImagesResponse> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') throw new FreeTierUnsupportedError('/v1/images/generations');
  if (callerTier !== 'prepaid') throw new UnknownCallerTierError(deps.caller.id, callerTier);

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
    const route = await selectRoute(
      { serviceRegistry: deps.serviceRegistry, nodeIndex: deps.nodeIndex },
      { capability: 'images', offering: deps.body.model, tier: 'prepaid' },
    );

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: route.nodeId,
      recipientEthAddress: route.recipientEthAddress,
      pricePerWorkUnitWei: route.pricePerWorkUnitWei,
      workUnits: BigInt(n),
      capability: route.capability,
      offering: route.offering,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createImage({
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
    const returnedCount = response.data.length;
    if (returnedCount === 0) throw new MissingUsageError(route.nodeId);
    if (returnedCount > n) {
      throw new UpstreamNodeError(
        route.nodeId,
        200,
        `node returned ${returnedCount} images for n=${n}`,
      );
    }
    for (const entry of response.data) {
      if (responseFormat === 'url' && !entry.url) {
        throw new UpstreamNodeError(route.nodeId, 200, 'response_format=url but url missing');
      }
      if (responseFormat === 'b64_json' && !entry.b64_json) {
        throw new UpstreamNodeError(
          route.nodeId,
          200,
          'response_format=b64_json but b64_json missing',
        );
      }
    }

    const cost = computeImagesActualCost(
      returnedCount,
      deps.body.model,
      size,
      quality,
      deps.pricing,
    );
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
      callerId: deps.caller.id,
      workId,
      kind: 'images',
      model: deps.body.model,
      nodeUrl: route.url,
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
