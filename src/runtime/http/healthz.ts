import type { FastifyInstance } from 'fastify';

export function registerHealthzRoute(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ ok: true }));
}
