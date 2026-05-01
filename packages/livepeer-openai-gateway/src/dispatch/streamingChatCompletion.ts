import { randomUUID } from 'node:crypto';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import * as usageRecordsRepo from '@cloudspe/livepeer-openai-gateway-core/repo/usageRecords.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import {
  ChatCompletionChunkSchema,
  type ChatCompletionRequest,
  type Usage,
} from '@cloudspe/livepeer-openai-gateway-core/types/openai.js';
import {
  computeActualCost,
  estimateReservation,
  resolveTierForModel,
} from '@cloudspe/livepeer-openai-gateway-core/service/pricing/index.js';
import { UpstreamNodeError } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import type { TokenAuditService } from '@cloudspe/livepeer-openai-gateway-core/service/tokenAudit/index.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../providers/serviceRegistry.js';
import { selectRoute } from '../service/routing/selectRoute.js';

export interface StreamingChatCompletionDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ChatCompletionRequest;
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfigProvider;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  signal: AbortSignal;
  onStreamStart: () => void;
  writeChunk: (chunk: string) => void;
}

export async function dispatchStreamingChatCompletion(
  deps: StreamingChatCompletionDispatchDeps,
): Promise<void> {
  const callerTier = deps.caller.tier as 'free' | 'prepaid';
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

  const handle = await deps.wallet.reserve(deps.caller.id, reserveQuote);
  const customerAskedForUsage = deps.body.stream_options?.include_usage === true;
  const upstreamBody: ChatCompletionRequest = {
    ...deps.body,
    stream: true,
    stream_options: { include_usage: true },
  };

  let route;
  try {
    route = await selectRoute(
      { serviceRegistry: deps.serviceRegistry, nodeIndex: deps.nodeIndex },
      { capability: 'chat', offering: deps.body.model, tier: callerTier },
    );

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: route.nodeId,
      recipientEthAddress: route.recipientEthAddress,
      pricePerWorkUnitWei: route.pricePerWorkUnitWei,
      workUnits: BigInt(estimate.maxCompletionTokens),
      capability: route.capability,
      offering: route.offering,
      signal: deps.signal,
    });
    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const stream = await deps.nodeClient.streamChatCompletion({
      url: route.url,
      body: upstreamBody,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 300_000,
      signal: deps.signal,
    });
    if (!stream.events || stream.status >= 400) {
      deps.circuitBreaker.onFailure(route.nodeId, new Date());
      throw new UpstreamNodeError(
        route.nodeId,
        stream.status,
        (stream.rawErrorBody ?? '').slice(0, 512),
      );
    }
    deps.circuitBreaker.onSuccess(route.nodeId, new Date());

    deps.onStreamStart();

    let firstTokenDelivered = false;
    let accumulatedContent = '';
    let capturedUsage: Usage | null = null;

    try {
      for await (const ev of stream.events) {
        if (deps.signal.aborted) break;
        if (ev.data === '[DONE]') break;
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
          if (customerAskedForUsage) deps.writeChunk(`data: ${ev.data}\n\n`);
          continue;
        }

        const delta = chunk.data.choices[0]?.delta.content ?? '';
        if (delta.length > 0 && !firstTokenDelivered) firstTokenDelivered = true;
        accumulatedContent += delta;
        deps.writeChunk(`data: ${ev.data}\n\n`);
      }
    } catch {
      // fall through to settlement
    }

    const localCompletionTokens =
      deps.tokenAudit?.countCompletionText(deps.body.model, accumulatedContent) ?? null;

    const settlement = await settleReservation({
      wallet: deps.wallet,
      handle,
      db: deps.db,
      callerTier,
      callerId: deps.caller.id,
      workId,
      nodeUrl: route.url,
      nodeId: route.nodeId,
      model: deps.body.model,
      pricing: deps.pricing,
      estimate,
      capturedUsage,
      firstTokenDelivered,
      localCompletionTokens,
      paymentWei: payment.expectedValueWei,
      ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
      messages: deps.body.messages,
    });

    if (settlement.emittedError) {
      deps.writeChunk(`data: ${JSON.stringify(settlement.emittedError)}\n\n`);
    }
    deps.writeChunk('data: [DONE]\n\n');
  } catch (err) {
    try {
      await deps.wallet.refund(handle);
    } catch {
      // best-effort
    }
    throw err;
  }
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
  pricing: PricingConfigProvider;
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
        callerId: input.callerId,
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
      return {};
    } catch (err) {
      return {
        emittedError: {
          error: {
            code: 'internal_error',
            type: 'SettlementError',
            message: err instanceof Error ? err.message : 'settlement failed',
          },
        },
      };
    }
  }

  if (!input.firstTokenDelivered) {
    try {
      if (input.handle !== null) await input.wallet.refund(input.handle);
    } catch {
      // best-effort
    }
    return {
      emittedError: {
        error: {
          code: 'service_unavailable',
          type: 'UpstreamNodeError',
          message: 'upstream ended before first token',
        },
      },
    };
  }

  try {
    const completionTokens = Math.max(
      0,
      input.localCompletionTokens ?? Math.floor(input.estimate.maxCompletionTokens / 2),
    );
    const usage: Usage = {
      prompt_tokens: input.estimate.promptEstimateTokens,
      completion_tokens: completionTokens,
      total_tokens: input.estimate.promptEstimateTokens + completionTokens,
    };
    const cost = computeActualCost(usage, input.callerTier, input.model, input.pricing);
    if (input.handle !== null) {
      const report: UsageReport = {
        cents: cost.actualCents,
        wei: input.paymentWei,
        actualTokens: usage.total_tokens,
        model: input.model,
        capability: 'chat',
      };
      await input.wallet.commit(input.handle, report);
    }
    await usageRecordsRepo.insertUsageRecord(input.db, {
      callerId: input.callerId,
      workId: input.workId,
      model: input.model,
      nodeUrl: input.nodeUrl,
      promptTokensReported: usage.prompt_tokens,
      completionTokensReported: usage.completion_tokens,
      ...(input.localCompletionTokens !== null
        ? { completionTokensLocal: input.localCompletionTokens }
        : {}),
      costUsdCents: cost.actualCents,
      nodeCostWei: input.paymentWei.toString(),
      status: 'partial',
      errorCode: 'stream_terminated_early',
    });
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
  } catch (err) {
    return {
      emittedError: {
        error: {
          code: 'internal_error',
          type: 'SettlementError',
          message: err instanceof Error ? err.message : 'settlement failed',
        },
      },
    };
  }
}
