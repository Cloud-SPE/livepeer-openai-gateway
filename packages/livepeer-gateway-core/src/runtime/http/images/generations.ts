import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../../../providers/serviceRegistry.js';
import type { CircuitBreaker } from '../../../service/routing/circuitBreaker.js';
import type { QuoteCache } from '../../../service/routing/quoteCache.js';
import type { AuthResolver, Wallet } from '../../../interfaces/index.js';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { authPreHandler } from '../middleware/auth.js';
import { rateLimitPreHandler } from '../middleware/rateLimit.js';
import { MissingUsageError, toHttpError, UpstreamNodeError } from '../errors.js';
import { ImagesGenerationRequestSchema } from '../../../types/images.js';
import { dispatchImages } from '../../../dispatch/images.js';
import { FreeTierUnsupportedError } from '../../../dispatch/embeddings.js';

export interface ImagesDeps {
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  quoteCache: QuoteCache;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  wallet: Wallet;
  rateLimiter?: RateLimiter;
  pricing: PricingConfig;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export function registerImagesGenerationsRoute(
  app: FastifyInstance,
  deps: ImagesDeps,
): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authResolver);
  app.post('/v1/images/generations', { preHandler }, (req, reply) =>
    handleImagesGenerations(req, reply, deps),
  );
}

async function handleImagesGenerations(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ImagesDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = ImagesGenerationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }

  try {
    const response = await dispatchImages({
      wallet: deps.wallet,
      caller,
      body: parsed.data,
      db: deps.db,
      serviceRegistry: deps.serviceRegistry,
      circuitBreaker: deps.circuitBreaker,
      quoteCache: deps.quoteCache,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      ...(deps.rng !== undefined ? { rng: deps.rng } : {}),
    });
    await reply.code(200).send(response);
  } catch (err) {
    if (err instanceof FreeTierUnsupportedError) {
      await reply.code(402).send({
        error: { code: 'insufficient_quota', type: 'FreeTierUnsupported', message: err.message },
      });
      return;
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
