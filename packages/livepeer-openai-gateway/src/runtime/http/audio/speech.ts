/* v8 ignore file */

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
  toHttpError,
  UpstreamNodeError,
} from '@cloudspe/livepeer-openai-gateway-core/runtime/http/errors.js';
import { SpeechRequestSchema } from '@cloudspe/livepeer-openai-gateway-core/types/speech.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../../../providers/serviceRegistry.js';
import { dispatchSpeech } from '../../../dispatch/speech.js';
import { FreeTierUnsupportedError } from '../../../dispatch/embeddings.js';

export interface SpeechDeps {
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  wallet: Wallet;
  rateLimiter?: RateLimiter;
  pricing: PricingConfigProvider;
  nodeCallTimeoutMs?: number;
}

export function registerSpeechRoute(app: FastifyInstance, deps: SpeechDeps): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authResolver);
  app.post('/v1/audio/speech', { preHandler }, (req, reply) => handleSpeech(req, reply, deps));
}

async function handleSpeech(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: SpeechDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = SpeechRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }

  const controller = new AbortController();
  req.raw.on('close', () => controller.abort());

  try {
    const out = await dispatchSpeech({
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
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      signal: controller.signal,
    });
    reply.header('content-type', out.contentType);
    await reply.code(out.status).send(ReadableStream.from(out.stream));
  } catch (err) {
    if (err instanceof FreeTierUnsupportedError) {
      await reply.code(402).send({
        error: { code: 'insufficient_quota', type: err.name, message: err.message },
      });
      return;
    }
    if (err instanceof UpstreamNodeError) {
      await reply.code(503).send({
        error: { code: 'service_unavailable', type: err.name, message: err.message },
      });
      return;
    }
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
