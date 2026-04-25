import { randomUUID } from 'node:crypto';
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
import type { AuthService } from '../../../service/auth/authenticate.js';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { authPreHandler } from '../middleware/auth.js';
import { rateLimitPreHandler } from '../middleware/rateLimit.js';
import { pickNode } from '../../../service/routing/router.js';
import {
  computeImagesActualCost,
  estimateImagesReservation,
} from '../../../service/pricing/index.js';
import { MissingUsageError, toHttpError, UpstreamNodeError } from '../errors.js';
import {
  IMAGES_DEFAULT_N,
  IMAGES_DEFAULT_QUALITY,
  IMAGES_DEFAULT_RESPONSE_FORMAT,
  IMAGES_DEFAULT_SIZE,
  ImagesGenerationRequestSchema,
} from '../../../types/images.js';

export interface ImagesDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authService: AuthService;
  rateLimiter?: RateLimiter;
  pricing: PricingConfig;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export function registerImagesGenerationsRoute(
  app: FastifyInstance,
  deps: ImagesDeps,
): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authService), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authService);
  app.post('/v1/images/generations', { preHandler }, (req, reply) =>
    handleImagesGenerations(req, reply, deps),
  );
}

async function handleImagesGenerations(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ImagesDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = ImagesGenerationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }
  const body = parsed.data;

  const customerTier = caller.customer.tier;
  if (customerTier === 'free') {
    await reply.code(402).send({
      error: {
        code: 'insufficient_quota',
        type: 'FreeTierUnsupported',
        message: '/v1/images/generations is not available on the free tier',
      },
    });
    return;
  }

  const n = body.n ?? IMAGES_DEFAULT_N;
  const size = body.size ?? IMAGES_DEFAULT_SIZE;
  const quality = body.quality ?? IMAGES_DEFAULT_QUALITY;
  const responseFormat = body.response_format ?? IMAGES_DEFAULT_RESPONSE_FORMAT;
  const workId = `${caller.customer.id}:${randomUUID()}`;

  let estimate;
  try {
    estimate = estimateImagesReservation(n, body.model, size, quality, deps.pricing);
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  let reservation: PrepaidReserveResult | null = null;
  let committed = false;

  try {
    reservation = await reserve(deps.db, {
      customerId: caller.customer.id,
      workId,
      estCostCents: estimate.estCents,
    });

    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      body.model,
      customerTier,
      'images',
    );
    const quote = node.quotes.get(capabilityString('images'));
    if (!quote) {
      throw new UpstreamNodeError(node.config.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.config.id,
      quote,
      workUnits: BigInt(n),
      capability: capabilityString('images'),
      model: body.model,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createImage({
      url: node.config.url,
      body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
    });

    if (call.status >= 400 || call.response === null) {
      throw new UpstreamNodeError(node.config.id, call.status, call.rawBody.slice(0, 512));
    }

    const response = call.response;
    const returnedCount = response.data.length;

    if (returnedCount === 0) {
      throw new MissingUsageError(node.config.id);
    }
    if (returnedCount > n) {
      throw new UpstreamNodeError(
        node.config.id,
        200,
        `node returned ${returnedCount} images for n=${n}`,
      );
    }
    for (const entry of response.data) {
      if (responseFormat === 'url' && !entry.url) {
        throw new UpstreamNodeError(node.config.id, 200, 'response_format=url but url missing');
      }
      if (responseFormat === 'b64_json' && !entry.b64_json) {
        throw new UpstreamNodeError(
          node.config.id,
          200,
          'response_format=b64_json but b64_json missing',
        );
      }
    }

    const cost = computeImagesActualCost(returnedCount, body.model, size, quality, deps.pricing);
    const status = returnedCount < n ? 'partial' : 'success';

    await commit(deps.db, {
      reservationId: reservation.reservationId,
      actualCostCents: cost.actualCents,
    });
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: caller.customer.id,
      workId,
      kind: 'images',
      model: body.model,
      nodeUrl: node.config.url,
      imageCount: returnedCount,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status,
    });

    await reply.code(200).send(response);
  } catch (err) {
    if (reservation && !committed) {
      try {
        await refund(deps.db, reservation.reservationId);
      } catch {
        // Refund best-effort.
      }
    }

    if (err instanceof UpstreamNodeError || err instanceof MissingUsageError) {
      await reply.code(503).send({
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      });
      return;
    }

    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
