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
  computeEmbeddingsActualCost,
  estimateEmbeddingsReservation,
} from '../../../service/pricing/index.js';
import { MissingUsageError, toHttpError, UpstreamNodeError } from '../errors.js';
import {
  EmbeddingsRequestSchema,
  normalizeEmbeddingsInput,
} from '../../../types/embeddings.js';

export interface EmbeddingsDeps {
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

export function registerEmbeddingsRoute(app: FastifyInstance, deps: EmbeddingsDeps): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authService), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authService);
  app.post('/v1/embeddings', { preHandler }, (req, reply) =>
    handleEmbeddings(req, reply, deps),
  );
}

async function handleEmbeddings(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: EmbeddingsDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = EmbeddingsRequestSchema.safeParse(req.body);
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
        message: '/v1/embeddings is not available on the free tier',
      },
    });
    return;
  }

  const inputs = normalizeEmbeddingsInput(body.input);
  const workId = `${caller.customer.id}:${randomUUID()}`;

  let estimate;
  try {
    estimate = estimateEmbeddingsReservation(inputs, body.model, deps.pricing);
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
      'embeddings',
    );
    const quote = node.quotes.get(capabilityString('embeddings'));
    if (!quote) {
      throw new UpstreamNodeError(node.config.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.config.id,
      quote,
      workUnits: BigInt(estimate.promptEstimateTokens),
      capability: capabilityString('embeddings'),
      model: body.model,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createEmbeddings({
      url: node.config.url,
      body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
    });

    if (call.status >= 400 || call.response === null) {
      throw new UpstreamNodeError(node.config.id, call.status, call.rawBody.slice(0, 512));
    }

    const response = call.response;
    if (!response.usage || typeof response.usage.prompt_tokens !== 'number') {
      throw new MissingUsageError(node.config.id);
    }

    if (response.data.length !== inputs.length) {
      throw new UpstreamNodeError(
        node.config.id,
        200,
        `data.length (${response.data.length}) !== input.length (${inputs.length})`,
      );
    }
    if (body.dimensions !== undefined) {
      for (const entry of response.data) {
        if (Array.isArray(entry.embedding) && entry.embedding.length !== body.dimensions) {
          throw new UpstreamNodeError(
            node.config.id,
            200,
            `vector length ${entry.embedding.length} !== requested dimensions ${body.dimensions}`,
          );
        }
      }
    }

    const cost = computeEmbeddingsActualCost(
      response.usage.prompt_tokens,
      body.model,
      deps.pricing,
    );

    await commit(deps.db, {
      reservationId: reservation.reservationId,
      actualCostCents: cost.actualCents,
    });
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: caller.customer.id,
      workId,
      kind: 'embeddings',
      model: body.model,
      nodeUrl: node.config.url,
      promptTokensReported: response.usage.prompt_tokens,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    await reply.code(200).send(response);
  } catch (err) {
    if (reservation && !committed) {
      try {
        await refund(deps.db, reservation.reservationId);
      } catch {
        // Refund best-effort — surfacing the original error is more important.
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
