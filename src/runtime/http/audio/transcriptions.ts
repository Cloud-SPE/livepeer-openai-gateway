import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type { Db } from '../../../repo/db.js';
import * as usageRecordsRepo from '../../../repo/usageRecords.js';
import type { PricingConfig } from '../../../config/pricing.js';
import type { NodeClient } from '../../../providers/nodeClient.js';
import type { PaymentsService } from '../../../service/payments/createPayment.js';
import type { NodeBook } from '../../../service/nodes/nodebook.js';
import { capabilityString } from '../../../types/capability.js';
import {
  commit,
  refund,
  reserve,
  type PrepaidReserveResult,
} from '../../../service/billing/reservations.js';
import type { AuthService } from '../../../service/auth/authenticate.js';
import type { RateLimiter } from '../../../service/rateLimit/index.js';
import { authPreHandler } from '../middleware/auth.js';
import { rateLimitPreHandler } from '../middleware/rateLimit.js';
import { pickNode } from '../../../service/routing/router.js';
import {
  computeTranscriptionsActualCost,
  estimateTranscriptionsReservation,
} from '../../../service/pricing/index.js';
import { toHttpError, UpstreamNodeError, MissingUsageError } from '../errors.js';
import {
  TRANSCRIPTIONS_MAX_FILE_BYTES,
  TranscriptionsFormFieldsSchema,
} from '../../../types/transcriptions.js';

export interface TranscriptionsDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  paymentsService: PaymentsService;
  authService: AuthService;
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
      ? [authPreHandler(deps.authService), rateLimitPreHandler(deps.rateLimiter)]
      : authPreHandler(deps.authService);
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

  if (caller.customer.tier === 'free') {
    await reply.code(402).send({
      error: {
        code: 'insufficient_quota',
        type: 'FreeTierUnsupported',
        message: '/v1/audio/transcriptions is not available on the free tier',
      },
    });
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

  const workId = `${caller.customer.id}:${randomUUID()}`;
  let estimate;
  try {
    estimate = estimateTranscriptionsReservation(
      fileBuffer.length,
      fields.data.model,
      deps.pricing,
    );
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
    return;
  }

  let reservation: PrepaidReserveResult | null = null;
  let committed = false;

  try {
    reservation = await reserve(deps.db, {
      customerId: caller.customer.id,
      workId,
      estCostCents: estimate.estCents,
    });

    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      fields.data.model,
      caller.customer.tier,
      'transcriptions',
    );
    const quote = node.quotes.get(capabilityString('transcriptions'));
    if (!quote) {
      throw new UpstreamNodeError(node.config.id, null, 'quote not yet refreshed');
    }

    const payment = await deps.paymentsService.createPaymentForRequest({
      nodeId: node.config.id,
      quote,
      workUnits: BigInt(estimate.estimatedSeconds),
      capability: capabilityString('transcriptions'),
      model: fields.data.model,
    });
    const paymentHeaderB64 = Buffer.from(payment.paymentBytes).toString('base64');

    const upstreamAbort = new AbortController();
    req.raw.on('close', () => {
      if (!req.raw.complete) upstreamAbort.abort();
    });

    const { boundary, body: outboundBody, contentType } = buildOutboundMultipart({
      file: fileBuffer,
      fileName,
      fileMime,
      fields: {
        model: fields.data.model,
        prompt: fields.data.prompt,
        response_format: fields.data.response_format,
        temperature: fields.data.temperature?.toString(),
        language: fields.data.language,
      },
    });
    void boundary;

    const call = await deps.nodeClient.createTranscription({
      url: node.config.url,
      body: Readable.toWeb(Readable.from(outboundBody)) as unknown as ReadableStream<Uint8Array>,
      contentType,
      paymentHeaderB64,
      timeoutMs: deps.nodeCallTimeoutMs ?? 120_000,
      signal: upstreamAbort.signal,
    });

    if (call.status >= 400) {
      throw new UpstreamNodeError(
        node.config.id,
        call.status,
        (call.rawErrorBody ?? '').slice(0, 512),
      );
    }
    if (call.reportedDurationSeconds === null) {
      throw new MissingUsageError(node.config.id);
    }

    const cost = computeTranscriptionsActualCost(
      call.reportedDurationSeconds,
      fields.data.model,
      deps.pricing,
    );
    await commit(deps.db, {
      reservationId: reservation.reservationId,
      actualCostCents: cost.actualCents,
    });
    committed = true;

    await usageRecordsRepo.insertUsageRecord(deps.db, {
      customerId: caller.customer.id,
      workId,
      kind: 'transcriptions',
      model: fields.data.model,
      nodeUrl: node.config.url,
      durationSeconds: Math.ceil(call.reportedDurationSeconds),
      costUsdCents: cost.actualCents,
      nodeCostWei: payment.expectedValueWei.toString(),
      status: 'success',
    });

    reply.raw.statusCode = call.status;
    if (call.contentType) reply.raw.setHeader('content-type', call.contentType);
    reply.raw.end(call.bodyText);
  } catch (err) {
    if (reservation && !committed) {
      try {
        await refund(deps.db, reservation.reservationId);
      } catch {
        /* refund best-effort */
      }
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

interface OutboundMultipart {
  boundary: string;
  body: Buffer;
  contentType: string;
}

// buildOutboundMultipart constructs a fresh multipart/form-data body
// for forwarding to the worker. We re-encode (rather than relay the
// inbound stream) so we don't have to keep the inbound multipart parser
// alive while the worker call is in flight, and so we can append the
// validated form fields verbatim.
function buildOutboundMultipart(input: {
  file: Buffer;
  fileName: string;
  fileMime: string;
  fields: Record<string, string | undefined>;
}): OutboundMultipart {
  const boundary = '----livepeer-bridge-' + randomUUID().replace(/-/g, '');
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields)) {
    if (value === undefined) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName.replace(/"/g, '')}"\r\nContent-Type: ${input.fileMime}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(input.file);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
