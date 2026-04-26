import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import * as usageRecordsRepo from '../../../repo/usageRecords.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { NodeBook } from '../../../service/nodes/nodebook.js';
import { capabilityString } from '../../../types/capability.js';
import {
  commit,
  refund,
  reserve,
  type PrepaidReserveResult,
} from '../../../service/billing/reservations.js';
import type { AuthenticatedCaller } from '../../../service/auth/authenticate.js';
import type { AuthResolver } from '../../../interfaces/index.js';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { authPreHandler } from '../middleware/auth.js';
import { rateLimitPreHandler } from '../middleware/rateLimit.js';
import { pickNode } from '../../../service/routing/router.js';
import {
  computeSpeechActualCost,
  estimateSpeechReservation,
} from '../../../service/pricing/index.js';
import { toHttpError, UpstreamNodeError } from '../errors.js';
import { SpeechRequestSchema } from '../../../types/speech.js';

export interface SpeechDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  rateLimiter?: RateLimiter;
  pricing: PricingConfig;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export function registerSpeechRoute(app: FastifyInstance, deps: SpeechDeps): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authResolver);
  app.post('/v1/audio/speech', { preHandler }, (req, reply) => handleSpeech(req, reply, deps));
}

async function handleSpeech(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: SpeechDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }
  const inner = caller.metadata as AuthenticatedCaller;

  const parsed = SpeechRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }
  const body = parsed.data;

  if (inner.customer.tier === 'free') {
    await reply.code(402).send({
      error: {
        code: 'insufficient_quota',
        type: 'FreeTierUnsupported',
        message: '/v1/audio/speech is not available on the free tier',
      },
    });
    return;
  }

  // Char count is exact at the boundary — Zod enforces the upper bound,
  // so the reservation equals the commit. No reconciliation needed.
  const charCount = [...body.input].length;
  const workId = `${inner.customer.id}:${randomUUID()}`;

  let estimate;
  try {
    estimate = estimateSpeechReservation(charCount, body.model, deps.pricing);
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  let reservation: PrepaidReserveResult | null = null;
  let committed = false;

  try {
    reservation = await reserve(deps.db, {
      customerId: inner.customer.id,
      workId,
      estCostCents: estimate.estCents,
    });

    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      body.model,
      inner.customer.tier,
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
      model: body.model,
    });
    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');

    const upstreamAbort = new AbortController();
    // Customer disconnect (req.raw closes early) → cancel upstream so the
    // node can stop synthesizing.
    req.raw.on('close', () => {
      if (!req.raw.complete) upstreamAbort.abort();
    });

    const call = await deps.nodeClient.createSpeech({
      url: node.config.url,
      body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
      signal: upstreamAbort.signal,
    });

    if (call.status >= 400 || call.stream === null) {
      throw new UpstreamNodeError(
        node.config.id,
        call.status,
        (call.rawErrorBody ?? '').slice(0, 512),
      );
    }

    const cost = computeSpeechActualCost(charCount, body.model, deps.pricing);
    await commit(deps.db, {
      reservationId: reservation.reservationId,
      actualCostCents: cost.actualCents,
    });
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: inner.customer.id,
      workId,
      kind: 'speech',
      model: body.model,
      nodeUrl: node.config.url,
      charCount,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    // Pipe upstream bytes through. Always chunked (no Content-Length) —
    // we don't know the total without buffering.
    reply.raw.statusCode = call.status;
    reply.raw.setHeader('content-type', call.contentType ?? 'audio/mpeg');
    Readable.fromWeb(call.stream as unknown as import('stream/web').ReadableStream<Uint8Array>)
      .pipe(reply.raw);
  } catch (err) {
    if (reservation && !committed) {
      try {
        await refund(deps.db, reservation.reservationId);
      } catch {
        /* refund best-effort */
      }
    }
    if (err instanceof UpstreamNodeError) {
      await reply.code(503).send({
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      });
      return;
    }
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
