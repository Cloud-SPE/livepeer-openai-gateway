import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import { toHttpError } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import {
  ChatCompletionRequestSchema,
  type ChatCompletionRequest,
} from '@cloudspe/livepeer-openai-gateway-core/types/openai.js';
import type { TokenAuditService } from '@cloudspe/livepeer-openai-gateway-core/service/tokenAudit/index.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import type {
  AuthResolver,
  Wallet,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../../../providers/serviceRegistry.js';
import { dispatchStreamingChatCompletion } from '../../../dispatch/streamingChatCompletion.js';

export interface StreamingChatDeps {
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  wallet: Wallet;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  pricing: PricingConfigProvider;
  nodeCallTimeoutMs?: number;
}

export async function handleStreamingChatCompletion(
  req: FastifyRequest,
  reply: FastifyReply,
  body: ChatCompletionRequest,
  deps: StreamingChatDeps,
): Promise<void> {
  const parsed = ChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }

  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  try {
    let started = false;
    await dispatchStreamingChatCompletion({
      wallet: deps.wallet,
      caller,
      body: parsed.data,
      db: deps.db,
      serviceRegistry: deps.serviceRegistry,
      nodeIndex: deps.nodeIndex,
      circuitBreaker: deps.circuitBreaker,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
      ...(deps.recorder !== undefined ? { recorder: deps.recorder } : {}),
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      signal: req.raw.aborted ? AbortSignal.abort() : AbortSignal.timeout(24 * 60 * 60 * 1000),
      onStreamStart: () => {
        started = true;
        void reply
          .code(200)
          .headers({
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          })
          .raw.flushHeaders();
      },
      writeChunk: (chunk: string) => {
        reply.raw.write(chunk);
      },
    });
    if (!started) return;
    reply.raw.end();
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
