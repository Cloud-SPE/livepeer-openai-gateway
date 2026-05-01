/* v8 ignore file */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
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
import {
  TranscriptionsFormFieldsSchema,
  type TranscriptionsFormFields,
} from '@cloudspe/livepeer-openai-gateway-core/types/transcriptions.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { ServiceRegistryClient } from '../../../providers/serviceRegistry.js';
import { dispatchTranscriptions } from '../../../dispatch/transcriptions.js';
import { FreeTierUnsupportedError } from '../../../dispatch/embeddings.js';

export interface TranscriptionsDeps {
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

export async function registerTranscriptionsRoute(
  app: FastifyInstance,
  deps: TranscriptionsDeps,
): Promise<void> {
  await app.register(multipart);
  const preHandler = deps.rateLimiter
    ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
    : authPreHandler(deps.authResolver);
  app.post('/v1/audio/transcriptions', { preHandler }, (req, reply) =>
    handleTranscriptions(req, reply, deps),
  );
}

async function handleTranscriptions(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: TranscriptionsDeps,
): Promise<void> {
  const caller = req.caller;
  if (!caller) {
    const { status, envelope } = toHttpError(new Error('missing caller'));
    await reply.code(status).send(envelope);
    return;
  }

  try {
    const mp = await req.file();
    if (!mp) {
      await reply.code(400).send({
        error: {
          code: 'invalid_request_error',
          type: 'InvalidMultipart',
          message: 'file is required',
        },
      });
      return;
    }
    const file = Buffer.from(await mp.toBuffer());
    const fieldValue = (name: string): string | undefined => {
      const field = mp.fields[name];
      if (!field || Array.isArray(field) || field.type !== 'field') return undefined;
      return String(field.value);
    };
    const bodyFields = {
      model: fieldValue('model') ?? '',
      prompt: fieldValue('prompt'),
      response_format: fieldValue('response_format'),
      temperature: fieldValue('temperature') ? Number(fieldValue('temperature')) : undefined,
      language: fieldValue('language'),
    };
    const parsed = TranscriptionsFormFieldsSchema.safeParse(bodyFields);
    if (!parsed.success) {
      const { status, envelope } = toHttpError(parsed.error);
      await reply.code(status).send(envelope);
      return;
    }

    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());

    const out = await dispatchTranscriptions({
      wallet: deps.wallet,
      caller,
      file,
      fileName: mp.filename,
      fileMime: mp.mimetype,
      fields: parsed.data as TranscriptionsFormFields,
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
    if (out.contentType) reply.header('content-type', out.contentType);
    await reply.code(out.status).send(out.bodyText);
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
