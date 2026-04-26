import { Readable } from 'node:stream';
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
import { toHttpError, UpstreamNodeError } from '../errors.js';
import { SpeechRequestSchema } from '../../../types/speech.js';
import { dispatchSpeech } from '../../../dispatch/speech.js';
import { FreeTierUnsupportedError } from '../../../dispatch/embeddings.js';

export interface SpeechDeps {
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

  const upstreamAbort = new AbortController();
  // Customer disconnect (req.raw closes early) → cancel upstream so the
  // node can stop synthesizing.
  req.raw.on('close', () => {
    if (!req.raw.complete) upstreamAbort.abort();
  });

  try {
    const result = await dispatchSpeech({
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
      signal: upstreamAbort.signal,
    });

    reply.raw.statusCode = result.status;
    reply.raw.setHeader('content-type', result.contentType);
    Readable.fromWeb(
      result.stream as unknown as import('stream/web').ReadableStream<Uint8Array>,
    ).pipe(reply.raw);
  } catch (err) {
    if (err instanceof FreeTierUnsupportedError) {
      await reply.code(402).send({
        error: { code: 'insufficient_quota', type: 'FreeTierUnsupported', message: err.message },
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
