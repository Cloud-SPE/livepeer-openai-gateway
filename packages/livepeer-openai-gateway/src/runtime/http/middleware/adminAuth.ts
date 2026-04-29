import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../../../repo/db.js';
import type { AdminConfig } from '../../../config/admin.js';
import * as adminAuditEventsRepo from '../../../repo/adminAuditEvents.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminActor?: string;
  }
}

export interface AdminAuthDeps {
  db: Db;
  config: AdminConfig;
}

export function adminAuthPreHandler(deps: AdminAuthDeps): preHandlerAsyncHookHandler {
  const expectedHash = createHash('sha256').update(deps.config.token).digest();

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers['x-admin-token'];
    const token = typeof header === 'string' ? header : undefined;
    if (!token || token.length !== deps.config.token.length) {
      await writeAuditAndReject(
        deps.db,
        req,
        reply,
        'unknown',
        401,
        'missing or malformed X-Admin-Token',
      );
      return;
    }

    const provided = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(provided, expectedHash)) {
      await writeAuditAndReject(deps.db, req, reply, 'unknown', 401, 'invalid admin token');
      return;
    }

    const ip = extractClientIp(req);
    if (deps.config.ipAllowlist.length > 0 && !deps.config.ipAllowlist.includes(ip)) {
      await writeAuditAndReject(
        deps.db,
        req,
        reply,
        actorFromToken(token),
        403,
        `IP ${ip} not on admin allowlist`,
      );
      return;
    }

    // Honor X-Admin-Actor when present and well-formed — operators set this
    // at sign-in so audit rows carry a human-readable handle. Falls back to
    // the token-hash when missing or malformed.
    const actorHeader = req.headers['x-admin-actor'];
    const actorClaim =
      typeof actorHeader === 'string' && ADMIN_ACTOR_PATTERN.test(actorHeader) ? actorHeader : null;
    req.adminActor = actorClaim ?? actorFromToken(token);

    // Record success after the handler replies so status_code reflects outcome.
    reply.raw.on('close', () => {
      void adminAuditEventsRepo.recordEvent(deps.db, {
        actor: req.adminActor ?? 'unknown',
        action: `${req.method} ${req.url.split('?')[0]}`,
        ...(typeof req.params === 'object' && req.params !== null && 'id' in req.params
          ? { targetId: String((req.params as { id: unknown }).id) }
          : {}),
        payload: safeJson(req.body),
        statusCode: reply.statusCode,
      });
    });
  };
}

async function writeAuditAndReject(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  actor: string,
  statusCode: number,
  message: string,
): Promise<void> {
  try {
    await adminAuditEventsRepo.recordEvent(db, {
      actor,
      action: `${req.method} ${req.url.split('?')[0]}`,
      ...(typeof req.params === 'object' && req.params !== null && 'id' in req.params
        ? { targetId: String((req.params as { id: unknown }).id) }
        : {}),
      payload: safeJson(req.body),
      statusCode,
    });
  } catch {
    // Audit write failures should not affect the response.
  }
  await reply.code(statusCode).send({
    error: {
      code: statusCode === 401 ? 'admin_unauthorized' : 'admin_forbidden',
      type: 'AdminAuthError',
      message,
    },
  });
}

// X-Admin-Actor header validation regex. Bounded free-text — keeps the column
// useful (recognizable handles, not opaque hashes) without inviting injection
// or unbounded growth. Matches the regex documented in 0023's plan.
const ADMIN_ACTOR_PATTERN = /^[a-z0-9._-]{1,64}$/;

function actorFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function extractClientIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip;
}

function safeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
