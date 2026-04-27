import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../../repo/db.js';
import type { AuthenticatedCaller } from '../../../service/auth/authenticate.js';
import type { AuthResolver } from '@cloud-spe/bridge-core/interfaces/index.js';
import type { AuthConfig } from '../../../config/auth.js';
import type { RateLimitConfig } from '@cloud-spe/bridge-core/config/rateLimit.js';
import { resolvePolicy } from '@cloud-spe/bridge-core/config/rateLimit.js';
import { issueKey } from '../../../service/auth/keys.js';
import * as apiKeysRepo from '../../../repo/apiKeys.js';
import * as customersRepo from '../../../repo/customers.js';
import * as topupsRepo from '../../../repo/topups.js';
import * as usageRollups from '@cloud-spe/bridge-core/repo/usageRollups.js';
import { authPreHandler } from '@cloud-spe/bridge-core/runtime/http/middleware/auth.js';
import { toHttpError } from '@cloud-spe/bridge-core/runtime/http/errors.js';

export interface AccountRoutesDeps {
  db: Db;
  authResolver: AuthResolver;
  authConfig: AuthConfig;
  rateLimitConfig: RateLimitConfig;
}

const CreateKeyBodySchema = z.object({
  label: z.string().min(1).max(64),
});

const UsageQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  group_by: z.enum(['day', 'model', 'capability']).default('day'),
});

const TopupsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const KeyIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRoutesDeps): void {
  const preHandler = authPreHandler(deps.authResolver);

  app.get('/v1/account', { preHandler }, (req, reply) => respondAccount(req, reply));
  app.get('/v1/account/limits', { preHandler }, (req, reply) => respondLimits(req, reply, deps));
  app.get('/v1/account/api-keys', { preHandler }, (req, reply) => respondListKeys(req, reply, deps));
  app.post('/v1/account/api-keys', { preHandler }, (req, reply) => handleCreateKey(req, reply, deps));
  app.delete<{ Params: { id: string } }>(
    '/v1/account/api-keys/:id',
    { preHandler },
    (req, reply) => handleRevokeKey(req, reply, deps),
  );
  app.get('/v1/account/usage', { preHandler }, (req, reply) => handleUsage(req, reply, deps));
  app.get('/v1/account/topups', { preHandler }, (req, reply) => handleTopups(req, reply, deps));
}

function requireCaller(req: FastifyRequest): AuthenticatedCaller {
  const caller = req.caller;
  if (!caller) throw new Error('caller missing on authenticated request');
  return caller.metadata as AuthenticatedCaller;
}

async function respondAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { customer } = requireCaller(req);
    await reply.send(serializeAccount(customer));
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

async function respondLimits(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AccountRoutesDeps,
): Promise<void> {
  try {
    const { customer } = requireCaller(req);
    const policy = resolvePolicy(deps.rateLimitConfig, customer.rateLimitTier);
    await reply.send({
      tier: customer.tier,
      max_concurrent: policy.concurrent,
      requests_per_minute: policy.perMinute,
      max_tokens_per_request: customer.tier === 'free' ? 1024 : 32_768,
      monthly_token_quota:
        customer.quotaMonthlyAllowance != null ? Number(customer.quotaMonthlyAllowance) : null,
    });
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

async function respondListKeys(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AccountRoutesDeps,
): Promise<void> {
  try {
    const { customer } = requireCaller(req);
    const rows = await apiKeysRepo.findByCustomer(deps.db, customer.id);
    await reply.send({ keys: rows.map(serializeKey) });
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

async function handleCreateKey(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AccountRoutesDeps,
): Promise<void> {
  const parsed = CreateKeyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(400).send({
      error: {
        code: 'invalid_request',
        type: 'InvalidRequestError',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }
  try {
    const { customer } = requireCaller(req);
    const result = await issueKey(deps.db, {
      customerId: customer.id,
      envPrefix: deps.authConfig.envPrefix,
      pepper: deps.authConfig.pepper,
      label: parsed.data.label,
    });
    const row = await apiKeysRepo.findById(deps.db, result.apiKeyId);
    if (!row) throw new Error('newly-created key disappeared');
    await reply.send({
      id: row.id,
      label: row.label,
      key: result.plaintext,
      created_at: row.createdAt.toISOString(),
    });
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

async function handleRevokeKey(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: AccountRoutesDeps,
): Promise<void> {
  const parsed = KeyIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    await reply.code(400).send({
      error: {
        code: 'invalid_request',
        type: 'InvalidRequestError',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }
  try {
    const { customer, apiKey } = requireCaller(req);
    if (parsed.data.id === apiKey.id) {
      await reply.code(412).send({
        error: {
          code: 'precondition_failed',
          type: 'CannotRevokeSelf',
          message: "Sign in with a different key before revoking the one you're using.",
        },
      });
      return;
    }
    const row = await apiKeysRepo.findById(deps.db, parsed.data.id);
    if (!row || row.customerId !== customer.id) {
      await reply.code(404).send({
        error: { code: 'not_found', type: 'NotFound', message: `key ${parsed.data.id}` },
      });
      return;
    }
    await apiKeysRepo.revoke(deps.db, row.id, new Date());
    await reply.code(204).send();
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

async function handleUsage(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AccountRoutesDeps,
): Promise<void> {
  const parsed = UsageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    await reply.code(400).send({
      error: {
        code: 'invalid_request',
        type: 'InvalidRequestError',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }
  try {
    const { customer } = requireCaller(req);
    const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const from = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = await usageRollups.rollup(deps.db, {
      callerId: customer.id,
      from,
      to,
      groupBy: parsed.data.group_by,
    });

    let promptTotal = 0;
    let completionTotal = 0;
    let requestsTotal = 0;
    let costTotalCents = 0n;
    for (const r of rows) {
      promptTotal += r.promptTokens;
      completionTotal += r.completionTokens;
      requestsTotal += r.requests;
      costTotalCents += r.costUsdCents;
    }

    await reply.send({
      rows: rows.map((r) => ({
        bucket: r.bucket,
        prompt_tokens: r.promptTokens,
        completion_tokens: r.completionTokens,
        requests: r.requests,
        cost_usd: formatUsd(r.costUsdCents),
        status_breakdown: {
          success: r.successCount,
          partial: r.partialCount,
          failed: r.failedCount,
        },
      })),
      totals: {
        prompt_tokens: promptTotal,
        completion_tokens: completionTotal,
        requests: requestsTotal,
        cost_usd: formatUsd(costTotalCents),
      },
    });
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

async function handleTopups(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AccountRoutesDeps,
): Promise<void> {
  const parsed = TopupsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    await reply.code(400).send({
      error: {
        code: 'invalid_request',
        type: 'InvalidRequestError',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      },
    });
    return;
  }
  try {
    const { customer } = requireCaller(req);
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : undefined;
    const rows = await topupsRepo.findByCustomer(deps.db, customer.id, {
      limit: parsed.data.limit,
      ...(cursor ? { cursorCreatedAt: cursor } : {}),
    });
    const next = rows.length === parsed.data.limit ? rows[rows.length - 1] : null;
    await reply.send({
      topups: rows.map(serializeTopup),
      next_cursor: next ? encodeCursor(next.createdAt) : null,
    });
  } catch (err) {
    const { status, envelope } = toHttpError(err);
    await reply.code(status).send(envelope);
  }
}

function serializeAccount(customer: customersRepo.CustomerRow): Record<string, unknown> {
  return {
    id: customer.id,
    email: customer.email,
    tier: customer.tier,
    status: customer.status,
    balance_usd: formatUsd(customer.balanceUsdCents),
    reserved_usd: formatUsd(customer.reservedUsdCents),
    free_tokens_remaining:
      customer.quotaTokensRemaining != null ? Number(customer.quotaTokensRemaining) : null,
    free_tokens_reset_at: customer.quotaResetAt ? customer.quotaResetAt.toISOString() : null,
    created_at: customer.createdAt.toISOString(),
  };
}

function serializeKey(row: apiKeysRepo.ApiKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    label: row.label,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

function serializeTopup(row: topupsRepo.TopupRow): Record<string, unknown> {
  return {
    id: row.id,
    stripe_session_id: row.stripeSessionId,
    amount_usd: formatUsd(row.amountUsdCents),
    status: row.status,
    created_at: row.createdAt.toISOString(),
    refunded_at: row.refundedAt ? row.refundedAt.toISOString() : null,
    disputed_at: row.disputedAt ? row.disputedAt.toISOString() : null,
  };
}

function formatUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}

function encodeCursor(createdAt: Date): string {
  return Buffer.from(createdAt.toISOString()).toString('base64url');
}

function decodeCursor(s: string): Date | undefined {
  try {
    const iso = Buffer.from(s, 'base64url').toString('utf8');
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}
