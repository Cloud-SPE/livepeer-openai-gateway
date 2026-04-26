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
import { ChatCompletionRequestSchema } from '../../../types/openai.js';
import { handleStreamingChatCompletion } from './streaming.js';
import type { TokenAuditService } from '../../../service/tokenAudit/index.js';
import type { Recorder } from '../../../providers/metrics/recorder.js';
import { dispatchChatCompletion } from '../../../dispatch/chatCompletion.js';

export interface ChatCompletionsDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authResolver: AuthResolver;
  wallet: Wallet;
  rateLimiter?: RateLimiter;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  pricing: PricingConfig;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
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
      nodeBook: deps.nodeBook,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      wallet: deps.wallet,
      ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
      ...(deps.recorder !== undefined ? { recorder: deps.recorder } : {}),
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      ...(deps.rng !== undefined ? { rng: deps.rng } : {}),
    });
    return;
  }

  try {
    const response = await dispatchChatCompletion({
      wallet: deps.wallet,
      caller,
      body,
      db: deps.db,
      nodeBook: deps.nodeBook,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
      ...(deps.recorder !== undefined ? { recorder: deps.recorder } : {}),
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      ...(deps.rng !== undefined ? { rng: deps.rng } : {}),
    });
    await reply.code(200).send(response);
  } catch (err) {
    if (err instanceof UpstreamNodeError || err instanceof MissingUsageError) {
      const code = err instanceof MissingUsageError ? 'service_unavailable' : 'service_unavailable';
      await reply.code(503).send({
        error: { code, type: err.name, message: err.message },
      });
      return;
    }
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}
