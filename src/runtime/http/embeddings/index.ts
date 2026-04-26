import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { NodeBook } from '../../../service/nodes/nodebook.js';
import type { AuthResolver, Wallet } from '../../../interfaces/index.js';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { authPreHandler } from '../middleware/auth.js';
import { rateLimitPreHandler } from '../middleware/rateLimit.js';
import { MissingUsageError, toHttpError, UpstreamNodeError } from '../errors.js';
import { EmbeddingsRequestSchema } from '../../../types/embeddings.js';
import { dispatchEmbeddings, FreeTierUnsupportedError } from '../../../dispatch/embeddings.js';

export interface EmbeddingsDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  wallet: Wallet;
  rateLimiter?: RateLimiter;
  pricing: PricingConfig;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

export function registerEmbeddingsRoute(app: FastifyInstance, deps: EmbeddingsDeps): void {
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authResolver);
  app.post('/v1/embeddings', { preHandler }, (req, reply) => handleEmbeddings(req, reply, deps));
}

async function handleEmbeddings(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: EmbeddingsDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const parsed = EmbeddingsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const { status, envelope } = toHttpError(parsed.error);
    await reply.code(status).send(envelope);
    return;
  }

  try {
    const response = await dispatchEmbeddings({
      wallet: deps.wallet,
      caller,
      body: parsed.data,
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
    await reply.code(200).send(response);
  } catch (err) {
    if (err instanceof FreeTierUnsupportedError) {
      await reply.code(402).send({
        error: { code: 'insufficient_quota', type: err.name, message: err.message },
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
