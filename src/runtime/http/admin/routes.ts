import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '../../../config/auth.js';
import type { AdminService } from '../../../service/admin/index.js';
import type { AdminAuthDeps } from '../middleware/adminAuth.js';
import { adminAuthPreHandler } from '../middleware/adminAuth.js';
import { issueKey } from '../../../service/auth/keys.js';
import * as adminAuditEventsRepo from '../../../repo/adminAuditEvents.js';
import * as apiKeysRepo from '../../../repo/apiKeys.js';
import * as customersRepo from '../../../repo/customers.js';
import * as nodeHealthRepo from '@cloud-spe/bridge-core/repo/nodeHealth.js';
import * as reservationsRepo from '../../../repo/reservations.js';
import * as topupsRepo from '../../../repo/topups.js';

export interface AdminRoutesDeps extends AdminAuthDeps {
  adminService: AdminService;
  authConfig: AuthConfig;
}

const RefundBodySchema = z.object({
  stripeSessionId: z.string().min(1),
  reason: z.string().min(1),
});

const CreateKeyBodySchema = z.object({
  label: z.string().min(1).max(64),
});

const CustomerSearchQuerySchema = z.object({
  q: z.string().optional(),
  tier: z.enum(['free', 'prepaid']).optional(),
  status: z.enum(['active', 'suspended', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const AuditQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

const ReservationsQuerySchema = z.object({
  state: z.enum(['open', 'committed', 'refunded']).default('open'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

const TopupsAdminQuerySchema = z.object({
  customer_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

const NodeEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const preHandler = adminAuthPreHandler(deps);

  app.get('/admin/health', { preHandler }, async () => deps.adminService.getHealth());

  app.get('/admin/nodes', { preHandler }, async () => ({
    nodes: deps.adminService.listNodes(),
  }));

  app.get<{ Params: { id: string } }>('/admin/nodes/:id', { preHandler }, async (req, reply) => {
    const detail = await deps.adminService.getNode(req.params.id);
    if (!detail) {
      await reply.code(404).send({
        error: { code: 'not_found', type: 'NotFound', message: `node ${req.params.id}` },
      });
      return;
    }
    return detail;
  });

  app.get<{ Params: { id: string } }>(
    '/admin/customers/:id',
    { preHandler },
    async (req, reply) => {
      const detail = await deps.adminService.getCustomer(req.params.id);
      if (!detail) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `customer ${req.params.id}` },
        });
        return;
      }
      return detail;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/customers/:id/refund',
    { preHandler },
    async (req, reply) => {
      const parsed = RefundBodySchema.safeParse(req.body);
      if (!parsed.success) {
        await reply.code(400).send({
          error: {
            code: 'invalid_request_error',
            type: 'InvalidRefundRequest',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        });
        return;
      }
      try {
        const result = await deps.adminService.reverseCustomerTopup({
          stripeSessionId: parsed.data.stripeSessionId,
          reason: parsed.data.reason,
        });
        return result;
      } catch (err) {
        await reply.code(400).send({
          error: {
            code: 'invalid_request_error',
            type: 'ReverseTopupFailed',
            message: err instanceof Error ? err.message : 'unknown',
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/customers/:id/suspend',
    { preHandler },
    async (req, reply) => {
      const ok = await deps.adminService.suspendCustomer(req.params.id);
      if (!ok) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `customer ${req.params.id}` },
        });
        return;
      }
      return { customerId: req.params.id, status: 'suspended' };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/customers/:id/unsuspend',
    { preHandler },
    async (req, reply) => {
      const ok = await deps.adminService.unsuspendCustomer(req.params.id);
      if (!ok) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `customer ${req.params.id}` },
        });
        return;
      }
      return { customerId: req.params.id, status: 'active' };
    },
  );

  app.get('/admin/escrow', { preHandler }, async () => deps.adminService.getEscrow());

  // ── New (0023) ────────────────────────────────────────────────────────────

  app.get('/admin/customers', { preHandler }, async (req, reply) => {
    const parsed = CustomerSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : undefined;
    const rows = await customersRepo.search(deps.db, {
      ...(parsed.data.q !== undefined ? { q: parsed.data.q } : {}),
      ...(parsed.data.tier ? { tier: parsed.data.tier } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      limit: parsed.data.limit,
      ...(cursor ? { cursorCreatedAt: cursor } : {}),
    });
    return {
      customers: rows.map((c) => ({
        id: c.id,
        email: c.email,
        tier: c.tier,
        status: c.status,
        balance_usd_cents: c.balanceUsdCents.toString(),
        created_at: c.createdAt.toISOString(),
      })),
      next_cursor:
        rows.length === parsed.data.limit && rows[rows.length - 1]
          ? encodeCursor(rows[rows.length - 1]!.createdAt)
          : null,
    };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/customers/:id/api-keys',
    { preHandler },
    async (req, reply) => {
      const idParsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!idParsed.success) {
        await reply.code(400).send(badRequest(idParsed.error));
        return;
      }
      const customer = await customersRepo.findById(deps.db, idParsed.data.id);
      if (!customer) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `customer ${idParsed.data.id}` },
        });
        return;
      }
      const rows = await apiKeysRepo.findByCustomer(deps.db, idParsed.data.id);
      return {
        keys: rows.map((k) => ({
          id: k.id,
          label: k.label,
          created_at: k.createdAt.toISOString(),
          last_used_at: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
          revoked_at: k.revokedAt ? k.revokedAt.toISOString() : null,
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/customers/:id/api-keys',
    { preHandler },
    async (req, reply) => {
      const idParsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!idParsed.success) {
        await reply.code(400).send(badRequest(idParsed.error));
        return;
      }
      const bodyParsed = CreateKeyBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        await reply.code(400).send(badRequest(bodyParsed.error));
        return;
      }
      const customer = await customersRepo.findById(deps.db, idParsed.data.id);
      if (!customer) {
        await reply.code(404).send({
          error: { code: 'not_found', type: 'NotFound', message: `customer ${idParsed.data.id}` },
        });
        return;
      }
      const result = await issueKey(deps.db, {
        customerId: customer.id,
        envPrefix: deps.authConfig.envPrefix,
        pepper: deps.authConfig.pepper,
        label: bodyParsed.data.label,
      });
      const row = await apiKeysRepo.findById(deps.db, result.apiKeyId);
      if (!row) throw new Error('newly-created key disappeared');
      return {
        id: row.id,
        label: row.label,
        key: result.plaintext,
        created_at: row.createdAt.toISOString(),
      };
    },
  );

  app.get('/admin/audit', { preHandler }, async (req, reply) => {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : undefined;
    const fromDate = parseOptionalIsoDate(parsed.data.from);
    const toDate = parseOptionalIsoDate(parsed.data.to);
    const rows = await adminAuditEventsRepo.search(deps.db, {
      ...(fromDate ? { from: fromDate } : {}),
      ...(toDate ? { to: toDate } : {}),
      ...(parsed.data.actor ? { actor: parsed.data.actor } : {}),
      ...(parsed.data.action ? { action: parsed.data.action } : {}),
      limit: parsed.data.limit,
      ...(cursor ? { cursorOccurredAt: cursor } : {}),
    });
    return {
      events: rows.map((e) => ({
        id: e.id,
        actor: e.actor,
        action: e.action,
        target_id: e.targetId,
        status_code: e.statusCode,
        occurred_at: e.occurredAt.toISOString(),
      })),
      next_cursor:
        rows.length === parsed.data.limit && rows[rows.length - 1]
          ? encodeCursor(rows[rows.length - 1]!.occurredAt)
          : null,
    };
  });

  app.get('/admin/reservations', { preHandler }, async (req, reply) => {
    const parsed = ReservationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : undefined;
    const rows = await reservationsRepo.listByState(deps.db, {
      state: parsed.data.state,
      limit: parsed.data.limit,
      ...(cursor ? { cursorCreatedAt: cursor } : {}),
    });
    return {
      reservations: rows.map((r) => ({
        id: r.id,
        customer_id: r.customerId,
        work_id: r.workId,
        kind: r.kind,
        amount_usd_cents: r.amountUsdCents != null ? r.amountUsdCents.toString() : null,
        amount_tokens: r.amountTokens != null ? r.amountTokens.toString() : null,
        state: r.state,
        created_at: r.createdAt.toISOString(),
        age_seconds: Math.max(0, Math.floor((Date.now() - r.createdAt.getTime()) / 1000)),
      })),
      next_cursor:
        rows.length === parsed.data.limit && rows[rows.length - 1]
          ? encodeCursor(rows[rows.length - 1]!.createdAt)
          : null,
    };
  });

  app.get('/admin/topups', { preHandler }, async (req, reply) => {
    const parsed = TopupsAdminQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      await reply.code(400).send(badRequest(parsed.error));
      return;
    }
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : undefined;
    const fromDate = parseOptionalIsoDate(parsed.data.from);
    const toDate = parseOptionalIsoDate(parsed.data.to);
    const rows = await topupsRepo.search(deps.db, {
      ...(parsed.data.customer_id ? { customerId: parsed.data.customer_id } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(fromDate ? { from: fromDate } : {}),
      ...(toDate ? { to: toDate } : {}),
      limit: parsed.data.limit,
      ...(cursor ? { cursorCreatedAt: cursor } : {}),
    });
    return {
      topups: rows.map((t) => ({
        id: t.id,
        customer_id: t.customerId,
        stripe_session_id: t.stripeSessionId,
        amount_usd_cents: t.amountUsdCents.toString(),
        status: t.status,
        created_at: t.createdAt.toISOString(),
        refunded_at: t.refundedAt ? t.refundedAt.toISOString() : null,
        disputed_at: t.disputedAt ? t.disputedAt.toISOString() : null,
      })),
      next_cursor:
        rows.length === parsed.data.limit && rows[rows.length - 1]
          ? encodeCursor(rows[rows.length - 1]!.createdAt)
          : null,
    };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/nodes/:id/events',
    { preHandler },
    async (req, reply) => {
      const idParsed = z.object({ id: z.string().min(1) }).safeParse(req.params);
      if (!idParsed.success) {
        await reply.code(400).send(badRequest(idParsed.error));
        return;
      }
      const queryParsed = NodeEventsQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        await reply.code(400).send(badRequest(queryParsed.error));
        return;
      }
      const cursor = queryParsed.data.cursor ? decodeCursor(queryParsed.data.cursor) : undefined;
      const rows = await nodeHealthRepo.searchEventsForNode(deps.db, {
        nodeId: idParsed.data.id,
        limit: queryParsed.data.limit,
        ...(cursor ? { cursorOccurredAt: cursor } : {}),
      });
      return {
        events: rows.map((e) => ({
          id: e.id,
          node_id: e.nodeId,
          kind: e.kind,
          detail: e.detail,
          occurred_at: e.occurredAt.toISOString(),
        })),
        next_cursor:
          rows.length === queryParsed.data.limit && rows[rows.length - 1]
            ? encodeCursor(rows[rows.length - 1]!.occurredAt)
            : null,
      };
    },
  );

}

// ── helpers ─────────────────────────────────────────────────────────────────

function badRequest(err: z.ZodError): { error: { code: string; type: string; message: string } } {
  return {
    error: {
      code: 'invalid_request',
      type: 'InvalidRequestError',
      message: err.issues.map((i) => i.message).join('; '),
    },
  };
}

function encodeCursor(at: Date): string {
  return Buffer.from(at.toISOString()).toString('base64url');
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

function parseOptionalIsoDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
