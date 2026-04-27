import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../../../providers/serviceRegistry.js';
import type { CircuitBreaker } from '../../../service/routing/circuitBreaker.js';
import type { QuoteCache } from '../../../service/routing/quoteCache.js';
import type { ChatCompletionRequest } from '../../../types/openai.js';
import type { Recorder } from '../../../providers/metrics/recorder.js';
import { toHttpError } from '../errors.js';
import type { TokenAuditService } from '../../../service/tokenAudit/index.js';
import type { Wallet } from '../../../interfaces/index.js';
import { dispatchStreamingChatCompletion } from '../../../dispatch/streamingChatCompletion.js';

export interface StreamingDeps {
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  quoteCache: QuoteCache;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  pricing: PricingConfig;
  wallet: Wallet;
  tokenAudit?: TokenAuditService;
  recorder?: Recorder;
  nodeCallTimeoutMs?: number;
  rng?: () => number;
}

/**
 * Thin Fastify wrapper around `dispatchStreamingChatCompletion`. Handles:
 *   - aborting the dispatcher's signal when either client connection
 *     closes (req.raw or reply.raw)
 *   - hijacking the reply + flushing SSE headers when the dispatcher
 *     signals it's about to stream (via `onStreamStart`)
 *   - mapping pre-stream throws to HTTP error envelopes when
 *     `onStreamStart` hasn't yet fired
 *
 * `body` is already Zod-parsed by the caller (completions.ts's
 * `ChatCompletionRequestSchema.safeParse`); no parse needed here.
 */
// eslint-disable-next-line livepeer-bridge/zod-at-boundary -- body already parsed by completions.ts wrapper
export async function handleStreamingChatCompletion(
  req: FastifyRequest,
  reply: FastifyReply,
  body: ChatCompletionRequest,
  deps: StreamingDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  const abortController = new AbortController();
  const onClientClose = (): void => {
    if (!reply.raw.writableEnded && !abortController.signal.aborted) {
      abortController.abort();
    }
  };
  reply.raw.on('close', onClientClose);
  req.raw.on('close', onClientClose);

  let started = false;
  const onStreamStart = (): void => {
    started = true;
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.flushHeaders();
  };
  const writeChunk = (chunk: string): void => {
    if (started) reply.raw.write(chunk);
  };

  try {
    await dispatchStreamingChatCompletion({
      wallet: deps.wallet,
      caller,
      body,
      db: deps.db,
      serviceRegistry: deps.serviceRegistry,
      circuitBreaker: deps.circuitBreaker,
      quoteCache: deps.quoteCache,
      nodeClient: deps.nodeClient,
      paymentsService: deps.paymentsService,
      pricing: deps.pricing,
      ...(deps.tokenAudit !== undefined ? { tokenAudit: deps.tokenAudit } : {}),
      ...(deps.recorder !== undefined ? { recorder: deps.recorder } : {}),
      ...(deps.nodeCallTimeoutMs !== undefined
        ? { nodeCallTimeoutMs: deps.nodeCallTimeoutMs }
        : {}),
      ...(deps.rng !== undefined ? { rng: deps.rng } : {}),
      signal: abortController.signal,
      onStreamStart,
      writeChunk,
    });
  } catch (err) {
    if (!started) {
      const { status, envelope } = toHttpError(err);
      await reply.code(status).send(envelope);
      return;
    }
    // Already streaming — dispatcher already wrote any error chunks it cared to.
  }
  if (started) reply.raw.end();
}
