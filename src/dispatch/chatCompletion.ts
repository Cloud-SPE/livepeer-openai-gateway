import { randomUUID } from 'node:crypto';
import type { Db } from '../repo/db.js';
import * as usageRecordsRepo from '../repo/usageRecords.js';
import type { PricingConfig } from '../config/pricing.js';
import type { NodeClient } from '../providers/nodeClient.js';
import type { PaymentsService } from '../service/payments/createPayment.js';
import type { NodeBook } from '../service/nodes/nodebook.js';
import { capabilityString } from '../types/capability.js';
import { pickNode } from '../service/routing/router.js';
import {
  computeActualCost,
  estimateReservation,
  resolveTierForModel,
} from '../service/pricing/index.js';
import { MissingUsageError, UpstreamNodeError } from '../runtime/http/errors.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../types/openai.js';
import type { TokenAuditService } from '../service/tokenAudit/index.js';
import type { Recorder } from '../providers/metrics/recorder.js';
import type {
  Caller,
  CostQuote,
  ReservationHandle,
  UsageReport,
  Wallet,
} from '../interfaces/index.js';

export interface ChatCompletionDispatchDeps {
  wallet: Wallet;
  caller: Caller;
  body: ChatCompletionRequest;
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

/**
 * Framework-free chat-completion dispatcher. Drives the full request
 * lifecycle: tier resolution → wallet reserve → node selection →
 * payment creation → upstream call → wallet commit → usage-record
 * persistence → drift emission. On error, refunds the wallet (best
 * effort) and re-throws.
 *
 * The Fastify wrapper at `src/runtime/http/chat/completions.ts` is the
 * thin glue that parses the body, resolves the caller via AuthResolver,
 * delegates to this function, and maps thrown errors via `toHttpError`.
 *
 * Per exec-plan 0025.
 */
export async function dispatchChatCompletion(
  deps: ChatCompletionDispatchDeps,
): Promise<ChatCompletionResponse> {
  // resolveTierForModel throws ModelNotFoundError; the wrapper maps it to
  // 404. Run before reservation so we don't hold a reservation we can't
  // satisfy.
  resolveTierForModel(deps.pricing, deps.body.model);

  const workId = `${deps.caller.id}:${randomUUID()}`;
  // Pricing currently types tier as 'free' | 'prepaid' (stage 1 hasn't
  // generalized it yet). Cast at the dispatcher boundary; the wallet
  // throws UnknownCallerTierError on unknown values, so unrecognized
  // tiers can't make it past reserve().
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

    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      deps.body.model,
      callerTier,
    );
    const quote = node.quotes.get(capabilityString('chat'));
    if (!quote) {
      throw new UpstreamNodeError(node.config.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.config.id,
      quote,
      workUnits: BigInt(estimate.maxCompletionTokens),
      capability: capabilityString('chat'),
      model: deps.body.model,
    });

    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');
    const call = await deps.nodeClient.createChatCompletion({
      url: node.config.url,
      body: deps.body,
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

    const cost = computeActualCost(response.usage, callerTier, deps.body.model, deps.pricing);

    const usage: UsageReport = {
      cents: cost.actualCents,
      wei: payment.expectedValueWei,
      actualTokens: response.usage.total_tokens,
      model: deps.body.model,
      capability: 'chat',
    };
    if (handle !== null) {
      await deps.wallet.commit(handle, usage);
    }
    committed = true;

    const completionText = response.choices.map((c) => c.message.content).join('') ?? '';
    const localPrompt = deps.tokenAudit?.countPromptTokens(deps.body.model, deps.body.messages) ?? null;
    const localCompletion =
      deps.tokenAudit?.countCompletionText(deps.body.model, completionText) ?? null;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: deps.caller.id,
      workId,
      model: deps.body.model,
      nodeUrl: node.config.url,
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
        nodeId: node.config.id,
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
        // Refund best-effort — surfacing the original error is more important.
      }
    }
    throw err;
  }
}
