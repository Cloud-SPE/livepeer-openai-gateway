import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type { Db } from '../../../repo/db.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { NodeBook } from '../../../service/nodes/nodebook.js';
import type { AuthResolver, Wallet } from '../../../interfaces/index.js';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { authPreHandler } from '../middleware/auth.js';
import { rateLimitPreHandler } from '../middleware/rateLimit.js';
import { toHttpError, UpstreamNodeError, MissingUsageError } from '../errors.js';
import {
  TRANSCRIPTIONS_MAX_FILE_BYTES,
  TranscriptionsFormFieldsSchema,
} from '../../../types/transcriptions.js';
import { dispatchTranscriptions } from '../../../dispatch/transcriptions.js';
import { FreeTierUnsupportedError } from '../../../dispatch/embeddings.js';

export interface TranscriptionsDeps {
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

// Registers @fastify/multipart locally — the plugin only attaches to
// the route created via the `attachFieldsToBody: false` default. Other
// handlers that expect JSON bodies are unaffected.
export async function registerTranscriptionsRoute(
  app: FastifyInstance,
  deps: TranscriptionsDeps,
): Promise<void> {
  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fileSize: TRANSCRIPTIONS_MAX_FILE_BYTES,
        files: 1,
        // Field-count cap covers the documented OpenAI transcriptions
        // form (model, file, prompt, response_format, temperature,
        // language) with margin for forward-compatible additions.
        fields: 10,
      },
    });
    const preHandler = deps.rateLimiter
      ? [authPreHandler(deps.authResolver), rateLimitPreHandler(deps.rateLimiter)]
      : authPreHandler(deps.authResolver);
    scope.post('/v1/audio/transcriptions', { preHandler }, (req, reply) =>
      handleTranscription(req, reply, deps),
    );
  });
}

// eslint-disable-next-line livepeer-bridge/zod-at-boundary -- multipart body must be drained before form fields can be Zod-parsed; the parse call is `TranscriptionsFormFieldsSchema.safeParse` further down, after the @fastify/multipart loop terminates.
async function handleTranscription(
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

  // Drain the multipart body to extract the form fields and the file
  // stream. We materialize the file to a Buffer up to the 25 MiB cap so
  // the reservation has a known size; full-streaming forward to the
  // worker is tracked as a follow-up (the bridge already enforces the
  // size cap via @fastify/multipart's fileSize limit).
  let model = '';
  let prompt: string | undefined;
  let responseFormat: string | undefined;
  let temperature: string | undefined;
  let language: string | undefined;
  let fileBuffer: Buffer | null = null;
  let fileName = 'audio';
  let fileMime = 'application/octet-stream';

  try {
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        if ((part.file as unknown as { truncated?: boolean }).truncated) {
          await reply.code(413).send({
            error: {
              code: 'invalid_request',
              type: 'PayloadTooLarge',
              message: `file exceeds ${TRANSCRIPTIONS_MAX_FILE_BYTES} bytes`,
            },
          });
          return;
        }
        fileBuffer = Buffer.concat(chunks);
        fileName = part.filename ?? fileName;
        fileMime = part.mimetype ?? fileMime;
        continue;
      }
      if (part.type === 'field') {
        const v = String(part.value);
        switch (part.fieldname) {
          case 'model':
            model = v;
            break;
          case 'prompt':
            prompt = v;
            break;
          case 'response_format':
            responseFormat = v;
            break;
          case 'temperature':
            temperature = v;
            break;
          case 'language':
            language = v;
            break;
          default:
            break;
        }
      }
    }
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  if (fileBuffer === null) {
    await reply.code(400).send({
      error: {
        code: 'invalid_request',
        type: 'MissingFile',
        message: 'multipart body is missing required `file` field',
      },
    });
    return;
  }

  const fields = TranscriptionsFormFieldsSchema.safeParse({
    model,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(language !== undefined ? { language } : {}),
  });
  if (!fields.success) {
    const { status, envelope } = toHttpError(fields.error);
    await reply.code(status).send(envelope);
    return;
  }

  const upstreamAbort = new AbortController();
  req.raw.on('close', () => {
    if (!req.raw.complete) upstreamAbort.abort();
  });

  try {
    const result = await dispatchTranscriptions({
      wallet: deps.wallet,
      caller,
      file: fileBuffer,
      fileName,
      fileMime,
      fields: fields.data,
      db: deps.db,
      nodeBook: deps.nodeBook,
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
    if (result.contentType) reply.raw.setHeader('content-type', result.contentType);
    reply.raw.end(result.bodyText);
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
