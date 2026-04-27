import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { creditTopup } from '../../../service/billing/topups.js';
import { CircuitBreaker } from '@cloudspe/livepeer-gateway-core/service/routing/circuitBreaker.js';
import { createNodeIndex } from '@cloudspe/livepeer-gateway-core/service/routing/nodeIndex.js';
import { createFastifyServer } from '@cloudspe/livepeer-gateway-core/providers/http/fastify.js';
import { createAdminService } from '../../../service/admin/index.js';
import { registerAdminRoutes } from './routes.js';
import type { PayerDaemonClient } from '@cloudspe/livepeer-gateway-core/providers/payerDaemon.js';

let pg: TestPg;

const ADMIN_TOKEN = 'a'.repeat(40);

function mockPayerDaemon(opts: { healthy?: boolean } = {}): PayerDaemonClient {
  return {
    async startSession() {
      return { workId: 'wrk' };
    },
    async createPayment() {
      return { paymentBytes: new Uint8Array([1]), ticketsCreated: 1, expectedValueWei: 10n };
    },
    async closeSession() {
      /* noop */
    },
    async getDepositInfo() {
      return { depositWei: 1_000n, reserveWei: 500n, withdrawRound: 0n };
    },
    isHealthy: () => opts.healthy ?? true,
    startHealthLoop: () => undefined,
    stopHealthLoop: () => undefined,
    async close() {
      /* noop */
    },
  };
}

async function buildServer(opts: { ipAllowlist?: string[] } = {}) {
  const nodeIndex = createNodeIndex([
    { id: 'node-admin', url: 'http://127.0.0.1:9999', capabilities: ['chat'], weight: 100 },
  ]);
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 3, coolDownSeconds: 60 });
  const adminService = createAdminService({
    db: pg.db,
    payerDaemon: mockPayerDaemon(),
    nodeIndex,
    circuitBreaker,
  });
  const server = await createFastifyServer({ logger: false });
  registerAdminRoutes(server.app, {
    db: pg.db,
    config: { token: ADMIN_TOKEN, ipAllowlist: opts.ipAllowlist ?? [] },
    adminService,
    authConfig: { pepper: 'admin-test-pepper-000', envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  await server.app.ready();
  return server;
}

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE app.admin_audit_events, app.api_keys, app.reservations, engine.usage_records, app.topups, app.stripe_webhook_events, engine.node_health_events, engine.node_health, app.customers CASCADE`,
  );
});

async function countAuditRows(): Promise<number> {
  const rows = await pg.db.execute(sql`SELECT count(*)::int as c FROM app.admin_audit_events`);
  return (rows.rows[0] as { c: number }).c;
}

describe('admin auth', () => {
  it('401s when X-Admin-Token is missing', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/admin/health' });
      expect(res.statusCode).toBe(401);
      expect(await countAuditRows()).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('401s on wrong token (constant-time compare)', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/health',
        headers: { 'x-admin-token': 'b'.repeat(40) },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('403s when client IP is not on a non-empty allowlist', async () => {
    const server = await buildServer({ ipAllowlist: ['10.0.0.1'] });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/health',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe('admin endpoints', () => {
  it('GET /admin/health returns composed health snapshot + writes audit row', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/health',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        payerDaemonHealthy: boolean;
        dbOk: boolean;
        nodeCount: number;
      };
      expect(body.payerDaemonHealthy).toBe(true);
      expect(body.dbOk).toBe(true);
      expect(body.nodeCount).toBe(1);

      // reply.raw 'close' is async; give the audit write a tick.
      await new Promise((r) => setTimeout(r, 50));
      expect(await countAuditRows()).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/nodes lists configured nodes', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/nodes',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { nodes: Array<{ id: string }> };
      expect(body.nodes.map((n) => n.id)).toContain('node-admin');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/nodes/:id returns detail including recentEvents (empty if no events)', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/nodes/node-admin',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; recentEvents: unknown[] };
      expect(body.id).toBe('node-admin');
      expect(Array.isArray(body.recentEvents)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/nodes/:id 404s for unknown node', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/nodes/does-not-exist',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/customers/:id returns customer + topups + usage', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'adm@x.io',
      tier: 'prepaid',
      balanceUsdCents: 1_000n,
    });
    await creditTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_adm_1',
      amountUsdCents: 2_000n,
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: `/admin/customers/${customer.id}`,
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        id: string;
        tier: string;
        topups: Array<{ stripeSessionId: string }>;
      };
      expect(body.id).toBe(customer.id);
      expect(body.topups).toHaveLength(1);
      expect(body.topups[0]!.stripeSessionId).toBe('cs_adm_1');
    } finally {
      await server.close();
    }
  });

  it('POST /admin/customers/:id/refund reverses the ledger (balance floored at 0)', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'refund@x.io',
      tier: 'prepaid',
      balanceUsdCents: 0n,
    });
    await creditTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_refund_1',
      amountUsdCents: 5_000n,
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: `/admin/customers/${customer.id}/refund`,
        headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
        payload: JSON.stringify({
          stripeSessionId: 'cs_refund_1',
          reason: 'customer requested via support',
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { newBalanceUsdCents: string; alreadyRefunded: boolean };
      expect(body.newBalanceUsdCents).toBe('0');
      expect(body.alreadyRefunded).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('POST /admin/customers/:id/refund rejects empty reason', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/customers/anything/refund',
        headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
        payload: JSON.stringify({ stripeSessionId: 'cs_refund_X', reason: '' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('suspend + unsuspend round-trip flips status', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'sus@x.io',
      tier: 'prepaid',
    });
    const server = await buildServer();
    try {
      const res1 = await server.app.inject({
        method: 'POST',
        url: `/admin/customers/${customer.id}/suspend`,
        headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res1.statusCode).toBe(200);

      const afterSuspend = await customersRepo.findById(pg.db, customer.id);
      expect(afterSuspend!.status).toBe('suspended');

      const res2 = await server.app.inject({
        method: 'POST',
        url: `/admin/customers/${customer.id}/unsuspend`,
        headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res2.statusCode).toBe(200);

      const afterUnsuspend = await customersRepo.findById(pg.db, customer.id);
      expect(afterUnsuspend!.status).toBe('active');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/escrow returns the PayerDaemon view', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/escrow',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { depositWei: string; reserveWei: string; source: string };
      expect(body.depositWei).toBe('1000');
      expect(body.reserveWei).toBe('500');
      expect(body.source).toBe('payer_daemon');
    } finally {
      await server.close();
    }
  });
});
