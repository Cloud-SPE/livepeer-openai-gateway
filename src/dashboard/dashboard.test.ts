import { describe, expect, it } from 'vitest';
import { createFastifyServer } from '../providers/http/fastify.js';
import { createBasicAdminAuthResolver } from '../service/admin/basicAuthResolver.js';
import type { EngineAdminService } from '../service/admin/engine.js';
import { registerOperatorDashboard } from './index.js';

function fakeEngineAdmin(): EngineAdminService {
  return {
    async getHealth() {
      return {
        ok: true,
        payerDaemonHealthy: true,
        dbOk: true,
        redisOk: true,
        nodeCount: 2,
        nodesHealthy: 2,
      };
    },
    listNodes() {
      return [
        {
          id: 'node-a',
          url: 'https://a.example',
          enabled: true,
          status: 'healthy',
          tierAllowed: ['prepaid'],
          supportedModels: ['m'],
          weight: 100,
        },
        {
          id: 'node-b',
          url: 'https://b.example',
          enabled: true,
          status: 'circuit_broken',
          tierAllowed: ['prepaid'],
          supportedModels: ['m'],
          weight: 100,
        },
      ];
    },
    async getNode() {
      return null;
    },
    async getEscrow() {
      return {
        depositWei: '0',
        reserveWei: '0',
        withdrawRound: '0',
        source: 'payer_daemon' as const,
      };
    },
  };
}

async function buildServer() {
  const server = await createFastifyServer({ logger: false });
  registerOperatorDashboard(server.app, {
    adminAuthResolver: createBasicAdminAuthResolver({ user: 'mike', pass: 'hunter2' }),
    engineAdminService: fakeEngineAdmin(),
    buildInfo: { version: '0.0.0-test', nodeVersion: '20.0.0', environment: 'test' },
  });
  await server.app.ready();
  return server;
}

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

describe('operator dashboard', () => {
  it('returns 401 with WWW-Authenticate when unauthenticated', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/ops/' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic /);
    } finally {
      await server.close();
    }
  });

  it('returns the dashboard HTML on valid auth', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/ops/',
        headers: { authorization: basic('mike', 'hunter2') },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('node-a');
      expect(res.body).toContain('https://a.example');
      expect(res.body).toContain('circuit_broken');
      expect(res.body).toContain('0.0.0-test');
    } finally {
      await server.close();
    }
  });

  it('serves the stylesheet on valid auth', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/ops/style.css',
        headers: { authorization: basic('mike', 'hunter2') },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
      expect(res.body).toContain('body');
    } finally {
      await server.close();
    }
  });
});
