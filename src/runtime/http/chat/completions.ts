import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import * as usageRecordsRepo from '../../../repo/usageRecords.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { NodeBook } from '../../../service/nodes/nodebook.js';
import {
  commit,
  commitQuota,
  refund,
  refundQuota,
  reserve,
  reserveQuota,
  type PrepaidReserveResult,
  type QuotaReserveResult,
} from '../../../service/billing/reservations.js';
import type { AuthService } from '../../../service/auth/authenticate.js';
import { authPreHandler } from '../middleware/auth.js';
import { pickNode } from '../../../service/routing/router.js';
import {
  computeActualCost,
  estimateReservation,
  resolveTierForModel,
} from '../../../service/pricing/index.js';
import { MissingUsageError, toHttpError, UpstreamNodeError } from '../errors.js';
import { ChatCompletionRequestSchema } from '../../../types/openai.js';
import { handleStreamingChatCompletion } from './streaming.js';

export interface ChatCompletionsDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authService: AuthService;
  pricing: PricingConfig;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  deps: ChatCompletionsDeps,
): void {
  app.post('/v1/chat/completions', { preHandler: authPreHandler(deps.authService) }, (req, reply) =>
    handleChatCompletion(req, reply, deps),
  );
}

async function handleChatCompletion(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ChatCompletionsDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = ChatCompletionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }
  const body = parsed.data;

  if (body.stream === true) {
    await handleStreamingChatCompletion(req, reply, body, {
      db: deps.db,
      nodeBook: deps.nodeBook,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      ...(deps.rng !== undefined ? { rng: deps.rng } : {}),
    });
    return;
  }

  try {
    resolveTierForModel(deps.pricing, body.model);
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  const workId = `${caller.customer.id}:${randomUUID()}`;
  const customerTier = caller.customer.tier;
  const estimate = estimateReservation(body, customerTier, deps.pricing);

  let reservation: PrepaidReserveResult | QuotaReserveResult | null = null;
  let committed = false;

  try {
    reservation =
      customerTier === 'prepaid'
        ? await reserve(deps.db, {
            customerId: caller.customer.id,
            workId,
            estCostCents: estimate.estCents,
          })
        : await reserveQuota(deps.db, {
            customerId: caller.customer.id,
            workId,
            estTokens: BigInt(estimate.promptEstimateTokens + estimate.maxCompletionTokens),
          });

    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      body.model,
      customerTier,
    );
    if (!node.quote) {
      throw new UpstreamNodeError(node.config.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.config.id,
      quote: node.quote,
      workUnits: BigInt(estimate.maxCompletionTokens),
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createChatCompletion({
      url: node.config.url,
      body,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 60_000,
    });

    if (call.status >= 400 || call.response === null) {
      throw new UpstreamNodeError(node.config.id, call.status, call.rawBody.slice(0, 512));
    }

    const response = call.response;
    if (!response.usage) {
      throw new MissingUsageError(node.config.id);
    }

    const cost = computeActualCost(response.usage, customerTier, body.model, deps.pricing);

    if (customerTier === 'prepaid') {
      await commit(deps.db, {
        reservationId: reservation.reservationId,
        actualCostCents: cost.actualCents,
      });
    } else {
      await commitQuota(deps.db, {
        reservationId: reservation.reservationId,
        actualTokens: BigInt(response.usage.total_tokens),
      });
    }
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: caller.customer.id,
      workId,
      model: body.model,
      nodeUrl: node.config.url,
      promptTokensReported: response.usage.prompt_tokens,
      completionTokensReported: response.usage.completion_tokens,
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    await reply.code(200).send(response);
  } catch (err) {
    if (reservation && !committed) {
      try {
        if (customerTier === 'prepaid') {
          await refund(deps.db, reservation.reservationId);
        } else {
          await refundQuota(deps.db, reservation.reservationId);
        }
      } catch {
        // Refund best-effort — surfacing the original error is more important.
      }
    }

    if (err instanceof UpstreamNodeError || err instanceof MissingUsageError) {
      const code = err instanceof MissingUsageError ? 'service_unavailable' : 'service_unavailable';
      await reply.code(503).send({
        error: { code, type: err.name, message: err.message },
      });
      return;
    }

    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
