import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AdminService } from '../../../service/admin/index.js';
import type { AdminAuthDeps } from '../middleware/adminAuth.js';
import { adminAuthPreHandler } from '../middleware/adminAuth.js';

export interface AdminRoutesDeps extends AdminAuthDeps {
  adminService: AdminService;
}

const RefundBodySchema = z.object({
  stripeSessionId: z.string().min(1),
  reason: z.string().min(1),
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
}
