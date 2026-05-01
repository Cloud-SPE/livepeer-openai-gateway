/* v8 ignore file */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import * as usageRecordsRepo from '@cloudspe/livepeer-openai-gateway-core/repo/usageRecords.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import {
  computeTranscriptionsActualCost,
  estimateTranscriptionsReservation,
} from '@cloudspe/livepeer-openai-gateway-core/service/pricing/index.js';
import {
  MissingUsageError,
  UpstreamNodeError,
} from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import type { TranscriptionsFormFields } from '@cloudspe/livepeer-openai-gateway-core/types/transcriptions.js';
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

export interface TranscriptionsDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  file: Buffer;
  fileName: string;
  fileMime: string;
  fields: TranscriptionsFormFields;
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

export interface TranscriptionsDispatchResult {
  bodyText: string;
  contentType: string | null;
  status: number;
}

export async function dispatchTranscriptions(
  deps: TranscriptionsDispatchDeps,
): Promise<TranscriptionsDispatchResult> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') throw new FreeTierUnsupportedError('/v1/audio/transcriptions');
  if (callerTier !== 'prepaid') throw new UnknownCallerTierError(deps.caller.id, callerTier);

  const workId = `${deps.caller.id}:${randomUUID()}`;
  const estimate = estimateTranscriptionsReservation(
    deps.file.length,
    deps.fields.model,
    deps.pricing,
  );

  const reserveQuote: CostQuote = {
    workId,
    cents: estimate.estCents,
    wei: 0n,
    estimatedTokens: 0,
    model: deps.fields.model,
    capability: 'transcriptions',
    callerTier,
  };

  let handle: ReservationHandle | null = null;
  let committed = false;

  try {
    handle = await deps.wallet.reserve(deps.caller.id, reserveQuote);
    const route = await selectRoute(
      { serviceRegistry: deps.serviceRegistry, nodeIndex: deps.nodeIndex },
      { capability: 'transcriptions', offering: deps.fields.model, tier: 'prepaid' },
    );

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: route.nodeId,
      recipientEthAddress: route.recipientEthAddress,
      pricePerWorkUnitWei: route.pricePerWorkUnitWei,
      workUnits: BigInt(estimate.estimatedSeconds),
      capability: route.capability,
      offering: route.offering,
      signal: deps.signal,
    });
    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');

    const { body: outboundBody, contentType: outboundContentType } = buildOutboundMultipart({
      file: deps.file,
      fileName: deps.fileName,
      fileMime: deps.fileMime,
      fields: {
        model: deps.fields.model,
        prompt: deps.fields.prompt,
        response_format: deps.fields.response_format,
        temperature: deps.fields.temperature?.toString(),
        language: deps.fields.language,
      },
    });

    const call = await deps.nodeClient.createTranscription({
      url: route.url,
      body: Readable.toWeb(Readable.from(outboundBody)) as ReadableStream<Uint8Array>,
      contentType: outboundContentType,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 120_000,
      signal: deps.signal,
    });

    if (call.status >= 400) {
      deps.circuitBreaker.onFailure(route.nodeId, new Date());
      throw new UpstreamNodeError(
        route.nodeId,
        call.status,
        (call.rawErrorBody ?? '').slice(0, 512),
      );
    }
    deps.circuitBreaker.onSuccess(route.nodeId, new Date());
    if (call.reportedDurationSeconds === null) {
      throw new MissingUsageError(route.nodeId);
    }

    const cost = computeTranscriptionsActualCost(
      call.reportedDurationSeconds,
      deps.fields.model,
      deps.pricing,
    );
    if (handle !== null) {
      const usage: UsageReport = {
        cents: cost.actualCents,
        wei: payment.expectedValueWei,
        actualTokens: 0,
        model: deps.fields.model,
        capability: 'transcriptions',
      };
      await deps.wallet.commit(handle, usage);
    }
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      callerId: deps.caller.id,
      workId,
      kind: 'transcriptions',
      model: deps.fields.model,
      nodeUrl: route.url,
      durationSeconds: Math.ceil(call.reportedDurationSeconds),
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    return {
      bodyText: call.bodyText,
      contentType: call.contentType,
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

interface OutboundMultipart {
  boundary: string;
  body: Buffer;
  contentType: string;
}

function buildOutboundMultipart(input: {
  file: Buffer;
  fileName: string;
  fileMime: string;
  fields: Record<string, string | undefined>;
}): OutboundMultipart {
  const boundary = '----livepeer-bridge-' + randomUUID().replace(/-/g, '');
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields)) {
    if (value === undefined) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName.replace(/"/g, '')}"\r\nContent-Type: ${input.fileMime}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(input.file);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
