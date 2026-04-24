import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import * as usageRecordsRepo from '../../../repo/usageRecords.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient, RawSseEvent } from '../../../providers/nodeClient.js';
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
import {
  ChatCompletionChunkSchema,
  type ChatCompletionRequest,
  type Usage,
} from '../../../types/openai.js';
import { runWithRetry, classifyNodeError } from '../../../service/routing/retry.js';
import {
  computeActualCost,
  estimateReservation,
  resolveTierForModel,
} from '../../../service/pricing/index.js';
import { toHttpError, UpstreamNodeError } from '../errors.js';
import { rateForTier } from '../../../config/pricing.js';
import type { TokenAuditService } from '../../../service/tokenAudit/index.js';

const MAX_RETRY_ATTEMPTS = 3;

export interface StreamingDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  tokenAudit?: TokenAuditService;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export async function handleStreamingChatCompletion(
  req: FastifyRequest,
  reply: FastifyReply,
  body: ChatCompletionRequest,
  deps: StreamingDeps,
): Promise<void> {
  const caller = req.caller!;
  const customerTier = caller.customer.tier;

  try {
    resolveTierForModel(deps.pricing, body.model);
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  const workId = `${caller.customer.id}:${randomUUID()}`;
  const estimate = estimateReservation(body, customerTier, deps.pricing, deps.tokenAudit);

  let reservation: PrepaidReserveResult | QuotaReserveResult;
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
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  const customerAskedForUsage = body.stream_options?.include_usage === true;
  const upstreamBody: ChatCompletionRequest = {
    ...body,
    stream: true,
    stream_options: { include_usage: true },
  };

  const abortController = new AbortController();
  const onClientClose = (): void => {
    if (!reply.raw.writableEnded && !abortController.signal.aborted) {
      abortController.abort();
    }
  };
  reply.raw.on('close', onClientClose);
  req.raw.on('close', onClientClose);

  const attemptResult = await runWithRetry(
    {
      nodeBook: deps.nodeBook,
      model: body.model,
      tier: customerTier,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      ...(deps.rng ? { rng: deps.rng } : {}),
    },
    async (ctx) => {
      const node = ctx.node;
      if (!node.quote) {
        return {
          ok: false as const,
          error: new Error('node quote not yet refreshed'),
          disposition: 'retry_next_node' as const,
          firstTokenDelivered: false,
        };
      }
      try {
        const payment = await deps.paymentsService.createPaymentForRequest({
          nodeId: node.config.id,
          quote: node.quote,
          workUnits: BigInt(estimate.maxCompletionTokens),
        });
        const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
        const stream = await deps.nodeClient.streamChatCompletion({
          url: node.config.url,
          body: upstreamBody,
          paymentHeaderB64,
          timeoutMs: deps.nodeCallTimeoutMs ?? 300_000,
          signal: abortController.signal,
        });
        if (!stream.events || stream.status >= 400) {
          return {
            ok: false as const,
            error: new UpstreamNodeError(
              node.config.id,
              stream.status,
              (stream.rawErrorBody ?? '').slice(0, 512),
            ),
            disposition: classifyNodeError(stream.status, false),
            firstTokenDelivered: false,
          };
        }
        return {
          ok: true as const,
          value: { node, events: stream.events, paymentWei: payment.expectedValueWei },
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err,
          disposition: classifyNodeError(null, false),
          firstTokenDelivered: false,
        };
      }
    },
  );

  if (!attemptResult.ok) {
    await refundSafely(deps.db, customerTier, reservation.reservationId);
    const { status, envelope } = toHttpError(attemptResult.error);
    await reply.code(status).send(envelope);
    return;
  }

  const { node, events, paymentWei } = attemptResult.value;

  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  raw.setHeader('cache-control', 'no-cache');
  raw.setHeader('connection', 'keep-alive');
  raw.flushHeaders();

  let firstTokenDelivered = false;
  let accumulatedContent = '';
  let capturedUsage: Usage | null = null;
  let streamNormallyEnded = false;

  try {
    for await (const ev of events) {
      if (abortController.signal.aborted) break;
      if (ev.data === '[DONE]') {
        streamNormallyEnded = true;
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const chunk = ChatCompletionChunkSchema.safeParse(parsed);
      if (!chunk.success) continue;

      if (chunk.data.usage) {
        capturedUsage = chunk.data.usage;
        if (customerAskedForUsage) {
          raw.write(`data: ${ev.data}\n\n`);
        }
        continue;
      }

      const delta = chunk.data.choices[0]?.delta.content ?? '';
      if (delta.length > 0 && !firstTokenDelivered) firstTokenDelivered = true;
      accumulatedContent += delta;
      raw.write(`data: ${ev.data}\n\n`);
    }
  } catch (err) {
    void err;
  }

  const localCompletionTokens =
    deps.tokenAudit?.countCompletionText(body.model, accumulatedContent) ?? null;

  const settlement = await settleReservation({
    db: deps.db,
    customerTier,
    reservationId: reservation.reservationId,
    customerId: caller.customer.id,
    workId,
    nodeUrl: node.config.url,
    model: body.model,
    pricing: deps.pricing,
    estimate,
    capturedUsage,
    firstTokenDelivered,
    streamNormallyEnded,
    localCompletionTokens,
    paymentWei,
    ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
    messages: body.messages,
    nodeId: node.config.id,
  });

  if (settlement.emittedError) {
    raw.write(`data: ${JSON.stringify(settlement.emittedError)}\n\n`);
  }
  raw.write('data: [DONE]\n\n');
  raw.end();
}

interface SettleInput {
  db: Db;
  customerTier: 'prepaid' | 'free';
  reservationId: string;
  customerId: string;
  workId: string;
  nodeUrl: string;
  nodeId: string;
  model: string;
  pricing: PricingConfig;
  estimate: ReturnType<typeof estimateReservation>;
  capturedUsage: Usage | null;
  firstTokenDelivered: boolean;
  streamNormallyEnded: boolean;
  localCompletionTokens: number | null;
  paymentWei: bigint;
  tokenAudit?: TokenAuditService;
  messages: readonly Parameters<NonNullable<TokenAuditService['countPromptTokens']>>[1][number][];
}

async function settleReservation(input: SettleInput): Promise<{
  emittedError?: {
    error: { code: string; type: string; message: string; tokens_delivered?: number };
  };
}> {
  if (input.capturedUsage) {
    const cost = computeActualCost(
      input.capturedUsage,
      input.customerTier,
      input.model,
      input.pricing,
    );
    try {
      if (input.customerTier === 'prepaid') {
        await commit(input.db, {
          reservationId: input.reservationId,
          actualCostCents: cost.actualCents,
        });
      } else {
        await commitQuota(input.db, {
          reservationId: input.reservationId,
          actualTokens: BigInt(input.capturedUsage.total_tokens),
        });
      }
      const localPrompt = input.tokenAudit?.countPromptTokens(input.model, input.messages) ?? null;
      await usageRecordsRepo.insertUsageRecord(input.db, {
        customerId: input.customerId,
        workId: input.workId,
        model: input.model,
        nodeUrl: input.nodeUrl,
        promptTokensReported: input.capturedUsage.prompt_tokens,
        completionTokensReported: input.capturedUsage.completion_tokens,
        ...(localPrompt !== null ? { promptTokensLocal: localPrompt } : {}),
        ...(input.localCompletionTokens !== null
          ? { completionTokensLocal: input.localCompletionTokens }
          : {}),
        costUsdCents: cost.actualCents,
        nodeCostWei: input.paymentWei.toString(),
        status: 'success',
      });
      if (input.tokenAudit && localPrompt !== null && input.localCompletionTokens !== null) {
        input.tokenAudit.emitDrift({
          model: input.model,
          nodeId: input.nodeId,
          localPromptTokens: localPrompt,
          reportedPromptTokens: input.capturedUsage.prompt_tokens,
          localCompletionTokens: input.localCompletionTokens,
          reportedCompletionTokens: input.capturedUsage.completion_tokens,
        });
      }
    } catch {
      // Settlement failed — best effort. Caller has no way to remediate here.
    }
    return {};
  }

  if (!input.firstTokenDelivered) {
    await refundSafely(input.db, input.customerTier, input.reservationId);
    return {
      emittedError: {
        error: {
          code: 'service_unavailable',
          type: 'StreamTerminatedEarly',
          message: 'upstream node returned no usage and no content',
          tokens_delivered: 0,
        },
      },
    };
  }

  // Tokens delivered but no usage chunk. With LocalTokenizer (0011) we can
  // commit the real completion count we accumulated during forwarding. If no
  // tokenAudit is wired, fall back to the prompt-estimate-only bill that
  // 0008 shipped as a stopgap.
  const pricingTier = input.estimate.pricingTier;
  const rate = rateForTier(input.pricing.rateCard, pricingTier);
  const localPrompt = input.tokenAudit?.countPromptTokens(input.model, input.messages) ?? null;
  const completionTokens = input.localCompletionTokens ?? 0;
  const promptTokens = localPrompt ?? input.estimate.promptEstimateTokens;

  const partialCents = ceilMicroCentsToCents(
    (BigInt(promptTokens) * BigInt(Math.round(rate.inputUsdPerMillion * 100 * 10_000))) /
      1_000_000n +
      (BigInt(completionTokens) * BigInt(Math.round(rate.outputUsdPerMillion * 100 * 10_000))) /
        1_000_000n,
  );

  try {
    if (input.customerTier === 'prepaid') {
      await commit(input.db, {
        reservationId: input.reservationId,
        actualCostCents: partialCents,
      });
    } else {
      await commitQuota(input.db, {
        reservationId: input.reservationId,
        actualTokens: BigInt(promptTokens + completionTokens),
      });
    }
    await usageRecordsRepo.insertUsageRecord(input.db, {
      customerId: input.customerId,
      workId: input.workId,
      model: input.model,
      nodeUrl: input.nodeUrl,
      promptTokensReported: promptTokens,
      completionTokensReported: Math.max(1, completionTokens),
      ...(localPrompt !== null ? { promptTokensLocal: localPrompt } : {}),
      ...(input.localCompletionTokens !== null
        ? { completionTokensLocal: input.localCompletionTokens }
        : {}),
      costUsdCents: partialCents,
      nodeCostWei: input.paymentWei.toString(),
      status: 'partial',
      errorCode: 'stream_terminated_early',
    });
  } catch {
    // Settlement best-effort.
  }

  return {
    emittedError: {
      error: {
        code: 'service_unavailable',
        type: 'StreamTerminatedEarly',
        message: 'upstream stream ended without usage chunk; billed prompt portion only',
        tokens_delivered: completionTokens,
      },
    },
  };
}

function ceilMicroCentsToCents(microCents: bigint): bigint {
  return (microCents + 9_999n) / 10_000n;
}

async function refundSafely(
  db: Db,
  tier: 'prepaid' | 'free',
  reservationId: string,
): Promise<void> {
  try {
    if (tier === 'prepaid') {
      await refund(db, reservationId);
    } else {
      await refundQuota(db, reservationId);
    }
  } catch {
    // Best-effort refund.
  }
}
