import { describe, expect, it } from 'vitest';
import { createFastifyServer } from '../../providers/http/fastify.js';
import { registerHealthzRoute } from './healthz.js';

describe('GET /healthz', () => {
  it('returns 200 { ok: true } without auth', async () => {
    const server = await createFastifyServer({ logger: false });
    registerHealthzRoute(server.app);
    await server.app.ready();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });
});
