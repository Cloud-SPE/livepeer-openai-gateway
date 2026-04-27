import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
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
  computeTranscriptionsActualCost,
  estimateTranscriptionsReservation,
} from '../service/pricing/index.js';
import { MissingUsageError, UpstreamNodeError } from '../runtime/http/errors.js';
import type { TranscriptionsFormFields } from '../types/transcriptions.js';
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

export interface TranscriptionsDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  /** File bytes extracted from the multipart upload. */
  file: Buffer;
  fileName: string;
  fileMime: string;
  fields: TranscriptionsFormFields;
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
  signal: AbortSignal;
}

export interface TranscriptionsDispatchResult {
  bodyText: string;
  contentType: string | null;
  status: number;
}

/**
 * Framework-free transcriptions dispatcher. Caller's wrapper handles
 * the multipart drain and validation; this function takes the
 * already-extracted file + parsed form fields and runs the full
 * reserve → call → commit lifecycle, then returns the upstream's
 * response body for the wrapper to relay.
 *
 * Per exec-plan 0025.
 */
export async function dispatchTranscriptions(
  deps: TranscriptionsDispatchDeps,
): Promise<TranscriptionsDispatchResult> {
  const callerTier = deps.caller.tier;
  if (callerTier === 'free') {
    throw new FreeTierUnsupportedError('/v1/audio/transcriptions');
  }
  if (callerTier !== 'prepaid') {
    throw new UnknownCallerTierError(deps.caller.id, callerTier);
  }

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

    const node = await selectNode(
      {
        serviceRegistry: deps.serviceRegistry,
        circuitBreaker: deps.circuitBreaker,
        ...(deps.rng ? { rng: deps.rng } : {}),
      },
      { capability: 'transcriptions', model: deps.fields.model, tier: 'prepaid' },
    );
    const quote = deps.quoteCache.get(node.id, capabilityString('transcriptions'));
    if (!quote) {
      throw new UpstreamNodeError(node.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.id,
      quote,
      workUnits: BigInt(estimate.estimatedSeconds),
      capability: capabilityString('transcriptions'),
      model: deps.fields.model,
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
      url: node.url,
      body: Readable.toWeb(Readable.from(outboundBody)) as unknown as ReadableStream<Uint8Array>,
      contentType: outboundContentType,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 120_000,
      signal: deps.signal,
    });

    if (call.status >= 400) {
      throw new UpstreamNodeError(
        node.id,
        call.status,
        (call.rawErrorBody ?? '').slice(0, 512),
      );
    }
    if (call.reportedDurationSeconds === null) {
      throw new MissingUsageError(node.id);
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
      nodeUrl: node.url,
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
