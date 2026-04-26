import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminAuthResolver } from '../interfaces/index.js';
import type { EngineAdminService } from '../service/admin/engine.js';
import { renderDashboardHtml, STYLE_CSS } from './views.js';

export interface OperatorDashboardDeps {
  /** URL prefix where the dashboard mounts. Defaults to `/admin/ops`. */
  mountPath?: string;
  /** Realm advertised on 401 challenges (browsers re-prompt with this). */
  realm?: string;
  adminAuthResolver: AdminAuthResolver;
  engineAdminService: EngineAdminService;
  buildInfo: { version: string; nodeVersion: string; environment: string };
}

/**
 * Engine's optional read-only operator dashboard. Vanilla server-rendered
 * HTML, no Lit/RxJS/React, no client framework — just enough to expose
 * node-pool health + payer-daemon status without a UI build step.
 *
 * Mounts at `mountPath` (default `/admin/ops`). Routes:
 *   - GET <mountPath>/        → HTML index page
 *   - GET <mountPath>/style.css → minimal CSS for the index page
 *
 * Auth is delegated to the supplied AdminAuthResolver. For OSS
 * operators without a token-issuing shell, wire
 * `createBasicAdminAuthResolver` from `service/admin/basicAuthResolver`.
 *
 * v1 is read-only by design (per exec-plan 0025). Action surface
 * (circuit-break, refresh-quote, etc.) deferred to a follow-up.
 *
 * Per exec-plan 0025.
 */
export function registerOperatorDashboard(
  app: FastifyInstance,
  deps: OperatorDashboardDeps,
): void {
  const mountPath = (deps.mountPath ?? '/admin/ops').replace(/\/$/, '');
  const realm = deps.realm ?? 'bridge-operator-dashboard';

  const requireAuth = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ actor: string } | null> => {
    const result = await deps.adminAuthResolver.resolve({
      headers: req.headers as Record<string, string | undefined>,
      ip: req.ip,
    });
    if (!result) {
      reply.header('www-authenticate', `Basic realm="${realm}"`);
      await reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    return result;
  };

  app.get(`${mountPath}/`, async (req, reply) => {
    const actor = await requireAuth(req, reply);
    if (!actor) return;
    const [health, nodes] = await Promise.all([
      deps.engineAdminService.getHealth(),
      Promise.resolve(deps.engineAdminService.listNodes()),
    ]);
    const html = renderDashboardHtml({
      build: deps.buildInfo,
      payerDaemon: { healthy: health.payerDaemonHealthy },
      nodes: nodes.map((n) => ({ id: n.id, url: n.url, status: n.status })),
    });
    reply.header('content-type', 'text/html; charset=utf-8');
    await reply.send(html);
  });

  app.get(`${mountPath}/style.css`, async (req, reply) => {
    const actor = await requireAuth(req, reply);
    if (!actor) return;
    reply.header('content-type', 'text/css; charset=utf-8');
    await reply.send(STYLE_CSS);
  });
}
