import { randomUUID } from 'node:crypto';
import type { Db } from '../repo/db.js';
import * as usageRecordsRepo from '../repo/usageRecords.js';
import type { PricingConfig } from '../config/pricing.js';
import { rateForTier } from '../config/pricing.js';
import type { NodeClient } from '../providers/nodeClient.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../providers/serviceRegistry.js';
import type { CircuitBreaker } from '../service/routing/circuitBreaker.js';
import type { QuoteCache } from '../service/routing/quoteCache.js';
import { capabilityString } from '../types/capability.js';
import {
  ChatCompletionChunkSchema,
  type ChatCompletionRequest,
  type Usage,
} from '../types/openai.js';
import { runWithRetry, classifyNodeError } from '../service/routing/retry.js';
import type { Recorder } from '../providers/metrics/recorder.js';
import {
  computeActualCost,
  estimateReservation,
  resolveTierForModel,
} from '../service/pricing/index.js';
import { UpstreamNodeError } from '../runtime/http/errors.js';
import type { TokenAuditService } from '../service/tokenAudit/index.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '../interfaces/index.js';

const MAX_RETRY_ATTEMPTS = 3;

export interface StreamingChatCompletionDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ChatCompletionRequest;
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  quoteCache: QuoteCache;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
  /** Aborted by the caller when the client connection closes. */
  signal: AbortSignal;
  /**
   * Called exactly once when the dispatcher commits to a 200 SSE
   * response (after pre-flight checks, reservation, node selection,
   * and the first upstream chunk is ready). The caller flushes
   * SSE-shaped headers in this callback. After this fires, all errors
   * surface as in-stream `data: ...` chunks rather than HTTP envelopes.
   */
  onStreamStart: () => void;
  /** Writes an SSE chunk to the client (already includes "data: " prefix and "\n\n"). */
  writeChunk: (chunk: string) => void;
}

/**
 * Framework-free streaming chat-completion dispatcher. Mirrors the
 * non-streaming dispatcher's lifecycle but with three settlement
 * paths:
 *   - upstream emitted a usage chunk → `wallet.commit` with reported actuals
 *   - no first token delivered → `wallet.refund`
 *   - first token delivered but no usage chunk → `wallet.commit` with
 *     partial estimate (LocalTokenizer when available, prompt-only fallback)
 *
 * Throws on pre-flight failures (tier mismatch, reservation, all
 * upstream attempts failed before any token shipped) — caller's
 * Fastify wrapper translates throws to HTTP envelopes IFF
 * `onStreamStart` hasn't fired yet. Once the SSE response is open,
 * the dispatcher swallows internal errors and emits in-stream error
 * chunks instead.
 *
 * Per exec-plan 0025.
 */
// `body` is already Zod-parsed by the caller (completions.ts's
// ChatCompletionRequestSchema.safeParse). No parse needed here.
// eslint-disable-next-line livepeer-bridge/zod-at-boundary
export async function dispatchStreamingChatCompletion(
  deps: StreamingChatCompletionDispatchDeps,
): Promise<void> {
  const callerTier = deps.caller.tier as 'free' | 'prepaid';

  // Pre-flight: tier resolution. Throws if model isn't on the rate card.
  resolveTierForModel(deps.pricing, deps.body.model);

  const workId = `${deps.caller.id}:${randomUUID()}`;
  const estimate = estimateReservation(deps.body, callerTier, deps.pricing, deps.tokenAudit);

  const reserveQuote: CostQuote = {
    workId,
    cents: estimate.estCents,
    wei: 0n,
    estimatedTokens: estimate.promptEstimateTokens + estimate.maxCompletionTokens,
    model: deps.body.model,
    capability: 'chat',
    callerTier,
  };

  // Reserve pre-stream. On failure throws — wrapper sends a non-200.
  const handle = await deps.wallet.reserve(deps.caller.id, reserveQuote);

  const customerAskedForUsage = deps.body.stream_options?.include_usage === true;
  const upstreamBody: ChatCompletionRequest = {
    ...deps.body,
    stream: true,
    stream_options: { include_usage: true },
  };

  const attemptResult = await runWithRetry(
    {
      serviceRegistry: deps.serviceRegistry,
      circuitBreaker: deps.circuitBreaker,
      model: deps.body.model,
      tier: callerTier,
      capability: 'chat',
      maxAttempts: MAX_RETRY_ATTEMPTS,
      ...(deps.rng ? { rng: deps.rng } : {}),
      ...(deps.recorder ? { recorder: deps.recorder } : {}),
    },
    async (ctx) => {
      const node = ctx.node;
      const quote = deps.quoteCache.get(node.id, capabilityString('chat'));
      if (!quote) {
        return {
          ok: false as const,
          error: new Error('node quote not yet refreshed'),
          disposition: 'retry_next_node' as const,
          firstTokenDelivered: false,
        };
      }
      try {
        const payment = await deps.paymentsService.createPaymentForRequest({
          nodeId: node.id,
          quote,
          workUnits: BigInt(estimate.maxCompletionTokens),
          capability: capabilityString('chat'),
          model: deps.body.model,
        });
        const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
        const stream = await deps.nodeClient.streamChatCompletion({
          url: node.url,
          body: upstreamBody,
          paymentHeaderB64,
          timeoutMs: deps.nodeCallTimeoutMs ?? 300_000,
          signal: deps.signal,
        });
        if (!stream.events || stream.status >= 400) {
          return {
            ok: false as const,
            error: new UpstreamNodeError(
              node.id,
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
    if (handle !== null) {
      try {
        await deps.wallet.refund(handle);
      } catch {
        // refund best-effort
      }
    }
    throw attemptResult.error;
  }

  const { node, events, paymentWei } = attemptResult.value;

  // Commit to the SSE response. After this point, all errors surface
  // as in-stream chunks, not HTTP envelopes.
  deps.onStreamStart();

  let firstTokenDelivered = false;
  let accumulatedContent = '';
  let capturedUsage: Usage | null = null;
  let streamNormallyEnded = false;

  try {
    for await (const ev of events) {
      if (deps.signal.aborted) break;
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
          deps.writeChunk(`data: ${ev.data}\n\n`);
        }
        continue;
      }

      const delta = chunk.data.choices[0]?.delta.content ?? '';
      if (delta.length > 0 && !firstTokenDelivered) firstTokenDelivered = true;
      accumulatedContent += delta;
      deps.writeChunk(`data: ${ev.data}\n\n`);
    }
  } catch (err) {
    void err;
  }

  void streamNormallyEnded;

  const localCompletionTokens =
    deps.tokenAudit?.countCompletionText(deps.body.model, accumulatedContent) ?? null;

  const settlement = await settleReservation({
    wallet: deps.wallet,
    handle,
    db: deps.db,
    callerTier,
    callerId: deps.caller.id,
    workId,
    nodeUrl: node.url,
    model: deps.body.model,
    pricing: deps.pricing,
    estimate,
    capturedUsage,
    firstTokenDelivered,
    localCompletionTokens,
    paymentWei,
    ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
    messages: deps.body.messages,
    nodeId: node.id,
  });

  if (settlement.emittedError) {
    deps.writeChunk(`data: ${JSON.stringify(settlement.emittedError)}\n\n`);
  }
  deps.writeChunk('data: [DONE]\n\n');
}

interface SettleInput {
  wallet: Wallet;
  handle: ReservationHandle | null;
  db: Db;
  callerTier: 'prepaid' | 'free';
  callerId: string;
  workId: string;
  nodeUrl: string;
  nodeId: string;
  model: string;
  pricing: PricingConfig;
  estimate: ReturnType<typeof estimateReservation>;
  capturedUsage: Usage | null;
  firstTokenDelivered: boolean;
  localCompletionTokens: number | null;
  paymentWei: bigint;
  tokenAudit?: TokenAuditService;
  messages: ChatCompletionRequest['messages'];
}

async function settleReservation(input: SettleInput): Promise<{
  emittedError?: {
    error: { code: string; type: string; message: string; tokens_delivered?: number };
  };
}> {
  if (input.capturedUsage) {
    const cost = computeActualCost(
      input.capturedUsage,
      input.callerTier,
      input.model,
      input.pricing,
    );
    try {
      if (input.handle !== null) {
        const usage: UsageReport = {
          cents: cost.actualCents,
          wei: input.paymentWei,
          actualTokens: input.capturedUsage.total_tokens,
          model: input.model,
          capability: 'chat',
        };
        await input.wallet.commit(input.handle, usage);
      }
      const localPrompt = input.tokenAudit?.countPromptTokens(input.model, input.messages) ?? null;
      await usageRecordsRepo.insertUsageRecord(input.db, {
        customerId: input.callerId,
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
      // Settlement failed — best effort.
    }
    return {};
  }

  if (!input.firstTokenDelivered) {
    if (input.handle !== null) {
      try {
        await input.wallet.refund(input.handle);
      } catch {
        // best-effort refund
      }
    }
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

  // Tokens delivered but no usage chunk: partial commit using local
  // tokenizer when available, prompt-estimate fallback otherwise.
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
    if (input.handle !== null) {
      const usage: UsageReport = {
        cents: partialCents,
        wei: input.paymentWei,
        actualTokens: promptTokens + completionTokens,
        model: input.model,
        capability: 'chat',
      };
      await input.wallet.commit(input.handle, usage);
    }
    await usageRecordsRepo.insertUsageRecord(input.db, {
      customerId: input.callerId,
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
