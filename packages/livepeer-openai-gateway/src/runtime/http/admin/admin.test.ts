import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { creditTopup } from '../../../service/billing/topups.js';
import { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import { createNodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { createAdminService } from '../../../service/admin/index.js';
import { registerAdminRoutes } from './routes.js';
import type { PayerDaemonClient } from '../../../providers/payerDaemon.js';

let pg: TestPg;

const ADMIN_TOKEN = 'a'.repeat(40);

function mockPayerDaemon(opts: { healthy?: boolean } = {}): PayerDaemonClient {
  return {
    async createPayment() {
      return { paymentBytes: new Uint8Array([1]), ticketsCreated: 1, expectedValueWei: 10n };
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

function mockServiceRegistry(
  opts: {
    healthy?: boolean;
    listKnown?: () => Promise<
      Array<{
        id: string;
        url: string;
        capabilities: (
          | 'chat'
          | 'embeddings'
          | 'images'
          | 'imagesEdits'
          | 'speech'
          | 'transcriptions'
        )[];
        weight?: number;
      }>
    >;
  } = {},
) {
  return {
    async select() {
      return [];
    },
    listKnown: opts.listKnown ?? (async () => []),
    isHealthy: () => opts.healthy ?? true,
  };
}

async function buildServer(
  opts: {
    ipAllowlist?: string[];
    serviceRegistry?: ReturnType<typeof mockServiceRegistry>;
  } = {},
) {
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
    serviceRegistry: opts.serviceRegistry ?? mockServiceRegistry(),
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
  it('401s when Authorization header is missing', async () => {
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
        headers: { authorization: `Bearer ${'b'.repeat(40)}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res1.statusCode).toBe(200);

      const afterSuspend = await customersRepo.findById(pg.db, customer.id);
      expect(afterSuspend!.status).toBe('suspended');

      const res2 = await server.app.inject({
        method: 'POST',
        url: `/admin/customers/${customer.id}/unsuspend`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
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
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
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

  it('POST /admin/customers creates a prepaid customer + returns detail shape', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/customers',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'create@x.io',
          tier: 'prepaid',
          balance_usd_cents: '5000',
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        id: string;
        email: string;
        tier: string;
        status: string;
        balanceUsdCents: string;
        rateLimitTier: string;
      };
      expect(body.email).toBe('create@x.io');
      expect(body.tier).toBe('prepaid');
      expect(body.status).toBe('active');
      expect(body.balanceUsdCents).toBe('5000');
      expect(body.rateLimitTier).toBe('default');

      // Persistence check.
      const row = await customersRepo.findById(pg.db, body.id);
      expect(row?.email).toBe('create@x.io');
      expect(row?.balanceUsdCents).toBe(5000n);
    } finally {
      await server.close();
    }
  });

  it('POST /admin/customers seeds quota_monthly_allowance + tokens_remaining for free tier', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/customers',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'free@x.io',
          tier: 'free',
          quota_monthly_allowance: '1000000',
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        id: string;
        quotaMonthlyAllowance: string | null;
        quotaTokensRemaining: string | null;
      };
      expect(body.quotaMonthlyAllowance).toBe('1000000');
      expect(body.quotaTokensRemaining).toBe('1000000');
    } finally {
      await server.close();
    }
  });

  it('POST /admin/customers returns 409 on duplicate email', async () => {
    await customersRepo.insertCustomer(pg.db, {
      email: 'dupe@x.io',
      tier: 'prepaid',
      balanceUsdCents: 0n,
      reservedUsdCents: 0n,
      quotaReservedTokens: 0n,
    });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/customers',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'dupe@x.io', tier: 'prepaid' }),
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { type: string } };
      expect(body.error.type).toBe('EmailAlreadyExists');
    } finally {
      await server.close();
    }
  });

  it('POST /admin/customers returns 400 on invalid body', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/admin/customers',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'not-an-email', tier: 'prepaid' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/health includes serviceRegistryHealthy', async () => {
    const server = await buildServer({
      serviceRegistry: mockServiceRegistry({ healthy: false }),
    });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/health',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { serviceRegistryHealthy: boolean };
      expect(body.serviceRegistryHealthy).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/registry/probe returns live listKnown + cached delta', async () => {
    const server = await buildServer({
      serviceRegistry: mockServiceRegistry({
        listKnown: async () => [
          { id: 'live-1', url: 'http://10.0.0.1:8935', capabilities: ['chat'], weight: 1 },
          { id: 'live-2', url: 'http://10.0.0.2:8935', capabilities: ['chat'], weight: 1 },
        ],
      }),
    });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/registry/probe',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        healthy: boolean;
        cachedCount: number;
        liveCount: number;
        durationMs: number;
        live: Array<{ id: string }>;
      };
      expect(body.healthy).toBe(true);
      expect(body.cachedCount).toBe(1); // node-admin from buildServer's nodeIndex
      expect(body.liveCount).toBe(2);
      expect(body.live.map((n) => n.id)).toEqual(['live-1', 'live-2']);
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
    }
  });

  it('GET /admin/registry/probe returns 503 when listKnown throws', async () => {
    const server = await buildServer({
      serviceRegistry: mockServiceRegistry({
        healthy: false,
        listKnown: async () => {
          throw new Error('UNAVAILABLE: socket connect failed');
        },
      }),
    });
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/registry/probe',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { healthy: boolean; liveCount: null; error: { message: string } };
      expect(body.healthy).toBe(false);
      expect(body.liveCount).toBe(null);
      expect(body.error.message).toContain('socket connect failed');
    } finally {
      await server.close();
    }
  });

  it('GET /admin/config/nodes returns the synthetic config-view envelope', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/config/nodes',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        path: string;
        sha256: string;
        mtime: string;
        size_bytes: number;
        contents: string;
        loaded_nodes: Array<{ id: string; url: string }>;
      };
      expect(body.path).toBe('<service-registry-daemon>');
      expect(body.sha256).toBe('');
      expect(body.size_bytes).toBe(0);
      expect(typeof body.mtime).toBe('string');
      expect(body.contents).toContain('service-registry-daemon');
      expect(body.loaded_nodes).toHaveLength(1);
      expect(body.loaded_nodes[0]?.id).toBe('node-admin');
    } finally {
      await server.close();
    }
  });
});
