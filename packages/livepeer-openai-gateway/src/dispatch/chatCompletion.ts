import { randomUUID } from 'node:crypto';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import * as usageRecordsRepo from '@cloudspe/livepeer-openai-gateway-core/repo/usageRecords.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import {
  computeActualCost,
  estimateReservation,
  resolveTierForModel,
} from '@cloudspe/livepeer-openai-gateway-core/service/pricing/index.js';
import {
  MissingUsageError,
  UpstreamNodeError,
} from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '@cloudspe/livepeer-openai-gateway-core/types/openai.js';
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

export interface ChatCompletionDispatchDeps {
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
}

export async function dispatchChatCompletion(
  deps: ChatCompletionDispatchDeps,
): Promise<ChatCompletionResponse> {
  resolveTierForModel(deps.pricing, deps.body.model);

  const workId = `${deps.caller.id}:${randomUUID()}`;
  const callerTier = deps.caller.tier as 'free' | 'prepaid';
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

  let handle: ReservationHandle | null = null;
  let committed = false;

  try {
    handle = await deps.wallet.reserve(deps.caller.id, reserveQuote);

    const route = await selectRoute(
      { serviceRegistry: deps.serviceRegistry, nodeIndex: deps.nodeIndex },
      { capability: 'chat', offering: deps.body.model, tier: callerTier },
    );

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: route.nodeId,
      recipientEthAddress: route.recipientEthAddress,
      pricePerWorkUnitWei: route.pricePerWorkUnitWei,
      workUnits: BigInt(estimate.maxCompletionTokens),
      capability: route.capability,
      model: deps.body.model,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createChatCompletion({
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
    if (!response.usage) {
      throw new MissingUsageError(route.nodeId);
    }

    const cost = computeActualCost(response.usage, callerTier, deps.body.model, deps.pricing);

    const usage: UsageReport = {
      cents: cost.actualCents,
      wei: payment.expectedValueWei,
      actualTokens: response.usage.total_tokens,
      model: deps.body.model,
      capability: 'chat',
    };
    if (handle !== null) await deps.wallet.commit(handle, usage);
    committed = true;

    const completionText = response.choices.map((c) => c.message.content).join('') ?? '';
    const localPrompt =
      deps.tokenAudit?.countPromptTokens(deps.body.model, deps.body.messages) ?? null;
    const localCompletion =
      deps.tokenAudit?.countCompletionText(deps.body.model, completionText) ?? null;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      callerId: deps.caller.id,
      workId,
      model: deps.body.model,
      nodeUrl: route.url,
      promptTokensReported: response.usage.prompt_tokens,
      completionTokensReported: response.usage.completion_tokens,
      ...(localPrompt !== null ? { promptTokensLocal: localPrompt } : {}),
      ...(localCompletion !== null ? { completionTokensLocal: localCompletion } : {}),
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    if (deps.tokenAudit && localPrompt !== null && localCompletion !== null) {
      deps.tokenAudit.emitDrift({
        model: deps.body.model,
        nodeId: route.nodeId,
        localPromptTokens: localPrompt,
        reportedPromptTokens: response.usage.prompt_tokens,
        localCompletionTokens: localCompletion,
        reportedCompletionTokens: response.usage.completion_tokens,
      });
    }

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
