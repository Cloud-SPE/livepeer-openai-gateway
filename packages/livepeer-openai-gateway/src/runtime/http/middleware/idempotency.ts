import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest, onSendHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../../../repo/db.js';
import type { AuthService } from '../../../service/auth/authenticate.js';
import * as idempotencyRepo from '../../../repo/idempotency.js';

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyContext?: {
      rowId: string;
    };
  }
}

const SUPPORTED_JSON_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/images/generations',
  '/v1/audio/speech',
  '/v1/billing/topup',
]);

const UNSUPPORTED_MULTIPART_PATHS = new Set(['/v1/audio/transcriptions']);

function pathOf(req: FastifyRequest): string {
  return req.url.split('?')[0] ?? req.url;
}

export interface IdempotencyDeps {
  db: Db;
  authService: AuthService;
}

export function idempotencyPreHandler(deps: IdempotencyDeps): preHandlerAsyncHookHandler {
  return async (req, reply) => {
    const idempotencyKey = header(req, 'idempotency-key');
    if (!idempotencyKey) return;

    if (req.method !== 'POST') return;
    const path = pathOf(req);
    if (!SUPPORTED_JSON_PATHS.has(path) && !UNSUPPORTED_MULTIPART_PATHS.has(path)) return;

    if (UNSUPPORTED_MULTIPART_PATHS.has(path)) {
      await reply.code(400).send(errorEnvelope('idempotency_unsupported', 'Idempotency-Key is not yet supported for multipart endpoints.'));
      return;
    }

    if (path === '/v1/chat/completions' && isStreamingChat(req.body)) {
      await reply
        .code(400)
        .send(errorEnvelope('idempotency_unsupported', 'Idempotency-Key is not yet supported for streaming chat completions.'));
      return;
    }

    const contentType = header(req, 'content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      await reply
        .code(400)
        .send(errorEnvelope('idempotency_unsupported', 'Idempotency-Key currently requires an application/json request body.'));
      return;
    }

    const caller = await deps.authService.authenticate(req.headers.authorization).catch(() => null);
    if (!caller) return;

    const requestHash = sha256(stableStringify({ method: req.method, path, body: req.body ?? null }));
    const existing = await idempotencyRepo.findByCustomerAndKey(
      deps.db,
      caller.customer.id,
      idempotencyKey,
    );
    if (existing) {
      await handleExisting(existing, requestHash, reply);
      return;
    }

    try {
      const inserted = await idempotencyRepo.insertPending(deps.db, {
        customerId: caller.customer.id,
        idempotencyKey,
        requestMethod: req.method,
        requestPath: path,
        requestHash,
      });
      req.idempotencyContext = { rowId: inserted.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await idempotencyRepo.findByCustomerAndKey(deps.db, caller.customer.id, idempotencyKey);
      if (!raced) throw err;
      await handleExisting(raced, requestHash, reply);
    }
  };
}

export function idempotencyOnSend(deps: IdempotencyDeps): onSendHookHandler {
  return async (req, reply, payload) => {
    const ctx = req.idempotencyContext;
    if (!ctx) return payload;

    delete req.idempotencyContext;
    if (reply.statusCode >= 500) {
      await idempotencyRepo.deleteById(deps.db, ctx.rowId);
      return payload;
    }

    const stored = serializePayload(payload);
    if (!stored) {
      await idempotencyRepo.deleteById(deps.db, ctx.rowId);
      return payload;
    }

    const responseContentType = stringifyHeader(reply.getHeader('content-type'));
    await idempotencyRepo.markCompleted(deps.db, ctx.rowId, {
      responseStatusCode: reply.statusCode,
      responseContentType,
      responseEncoding: stored.encoding,
      responseBody: stored.body,
    });
    return payload;
  };
}

async function handleExisting(
  existing: idempotencyRepo.IdempotencyRow,
  requestHash: string,
  reply: FastifyReply,
): Promise<void> {
  if (existing.requestHash !== requestHash) {
    await reply
      .code(409)
      .send(
        errorEnvelope(
          'idempotency_key_reused',
          'Idempotency-Key was already used for a different request payload.',
        ),
      );
    return;
  }

  if (
    existing.state === 'completed' &&
    existing.responseStatusCode !== null &&
    existing.responseEncoding !== null &&
    existing.responseBody !== null
  ) {
    if (existing.responseContentType) reply.header('content-type', existing.responseContentType);
    reply.header('Idempotency-Replayed', 'true');
    await reply.code(existing.responseStatusCode).send(decodeStoredBody(existing));
    return;
  }

  await reply
    .code(409)
    .send(
      errorEnvelope(
        'idempotency_in_progress',
        'Another request with this Idempotency-Key is still in progress.',
      ),
    );
}

function decodeStoredBody(row: idempotencyRepo.IdempotencyRow): Buffer | string {
  if (row.responseEncoding === 'base64') return Buffer.from(row.responseBody ?? '', 'base64');
  return row.responseBody ?? '';
}

function serializePayload(
  payload: unknown,
): { encoding: 'utf8' | 'base64'; body: string } | null {
  if (payload === undefined || payload === null) return { encoding: 'utf8', body: '' };
  if (typeof payload === 'string') return { encoding: 'utf8', body: payload };
  if (Buffer.isBuffer(payload)) return { encoding: 'base64', body: payload.toString('base64') };
  if (payload instanceof Uint8Array) {
    return { encoding: 'base64', body: Buffer.from(payload).toString('base64') };
  }
  if (typeof payload === 'object') {
    return { encoding: 'utf8', body: stableStringify(payload) };
  }
  return { encoding: 'utf8', body: String(payload) };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isStreamingChat(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && 'stream' in body && (body as { stream?: unknown }).stream === true);
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function stringifyHeader(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === '23505',
  );
}

function errorEnvelope(code: string, message: string): { error: { code: string; type: string; message: string } } {
  return { error: { code, type: 'IdempotencyError', message } };
}
