import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@cloudspe/livepeer-openai-gateway-core/repo/db.js';
import type { PricingConfigProvider } from '@cloudspe/livepeer-openai-gateway-core/config/pricing.js';
import type { NodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient.js';
import type { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import type { NodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import type {
  AuthResolver,
  Wallet,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import type { RateLimiter } from '@cloudspe/livepeer-openai-gateway-core/service/rateLimit/index.js';
import { authPreHandler } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/middleware/auth.js';
import { rateLimitPreHandler } from '@cloudspe/livepeer-openai-gateway-core/runtime/http/middleware/rateLimit.js';
import {
  MissingUsageError,
  toHttpError,
  UpstreamNodeError,
} from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import { ChatCompletionRequestSchema } from '@cloudspe/livepeer-openai-gateway-core/types/openai.js';
import type { TokenAuditService } from '@cloudspe/livepeer-openai-gateway-core/service/tokenAudit/index.js';
import type { Recorder } from '@cloudspe/livepeer-openai-gateway-core/providers/metrics/recorder.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../../../providers/serviceRegistry.js';
import { dispatchChatCompletion } from '../../../dispatch/chatCompletion.js';
import { handleStreamingChatCompletion } from './streaming.js';

export interface ChatCompletionsDeps {
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  wallet: Wallet;
  rateLimiter?: RateLimiter;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  pricing: PricingConfigProvider;
  nodeCallTimeoutMs?: number;
}

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  deps: ChatCompletionsDeps,
): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authResolver);
  app.post('/v1/chat/completions', { preHandler }, (req, reply) =>
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
      serviceRegistry: deps.serviceRegistry,
      nodeIndex: deps.nodeIndex,
      circuitBreaker: deps.circuitBreaker,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      wallet: deps.wallet,
      authResolver: deps.authResolver,
      ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
      ...(deps.recorder !== undefined ? { recorder: deps.recorder } : {}),
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
    });
    return;
  }

  try {
    const response = await dispatchChatCompletion({
      wallet: deps.wallet,
      caller,
      body,
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
    });
    await reply.code(200).send(response);
  } catch (err) {
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
