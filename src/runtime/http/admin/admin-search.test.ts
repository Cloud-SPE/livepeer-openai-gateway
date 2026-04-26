import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as adminAuditEventsRepo from '../../../repo/adminAuditEvents.js';
import * as apiKeysRepo from '../../../repo/apiKeys.js';
import * as customersRepo from '../../../repo/customers.js';
import * as nodeHealthRepo from '../../../repo/nodeHealth.js';
import * as reservationsRepo from '../../../repo/reservations.js';
import * as topupsRepo from '../../../repo/topups.js';
import { createNodesLoader } from '../../../service/nodes/loader.js';
import { NodeBook } from '../../../service/nodes/nodebook.js';
import { createFastifyServer } from '../../../providers/http/fastify.js';
import { createAdminService } from '../../../service/admin/index.js';
import { registerAdminRoutes } from './routes.js';
import type { PayerDaemonClient } from '../../../providers/payerDaemon.js';

let pg: TestPg;
const ADMIN_TOKEN = 'a'.repeat(40);
let nodesYamlPath: string;

function mockPayerDaemon(): PayerDaemonClient {
  return {
    async startSession() { return { workId: 'wrk' }; },
    async createPayment() { return { paymentBytes: new Uint8Array([1]), ticketsCreated: 1, expectedValueWei: 10n }; },
    async closeSession() { /* noop */ },
    async getDepositInfo() { return { depositWei: 1n, reserveWei: 1n, withdrawRound: 0n }; },
    isHealthy: () => true,
    startHealthLoop: () => undefined,
    stopHealthLoop: () => undefined,
    async close() { /* noop */ },
  };
}

function mkNodeBook(): NodeBook {
  const dir = mkdtempSync(path.join(tmpdir(), 'admin-search-'));
  nodesYamlPath = path.join(dir, 'nodes.yaml');
  writeFileSync(
    nodesYamlPath,
    `
nodes:
  - id: node-search
    url: http://127.0.0.1:9999
    ethAddress: "0x${'aa'.repeat(20)}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 100
`,
  );
  const nb = new NodeBook();
  createNodesLoader({ db: pg.db, nodeBook: nb, configPath: nodesYamlPath }).load();
  return nb;
}

async function buildServer() {
  const nodeBook = mkNodeBook();
  const adminService = createAdminService({
    db: pg.db,
    payerDaemon: mockPayerDaemon(),
    nodeBook,
  });
  const server = await createFastifyServer({ logger: false });
  registerAdminRoutes(server.app, {
    db: pg.db,
    config: { token: ADMIN_TOKEN, ipAllowlist: [] },
    adminService,
    authConfig: { pepper: 'admin-search-pepper-000', envPrefix: 'test', cacheTtlMs: 60_000 },
    nodesConfigPath: nodesYamlPath,
  });
  await server.app.ready();
  return server;
}

const authHeaders = (actor?: string) => ({
  'x-admin-token': ADMIN_TOKEN,
  ...(actor ? { 'x-admin-actor': actor } : {}),
});

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE admin_audit_event, api_key, reservation, usage_record, topup, stripe_webhook_event, node_health_event, node_health, customer CASCADE`,
  );
});

// ── X-Admin-Actor middleware ────────────────────────────────────────────────

describe('X-Admin-Actor middleware', () => {
  it('attributes audit rows to the X-Admin-Actor handle when valid', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/health', headers: authHeaders('alice'),
      });
      expect(res.statusCode).toBe(200);
      // Audit row written on response close — wait briefly for it.
      await new Promise((r) => setTimeout(r, 50));
      const rows = await adminAuditEventsRepo.search(pg.db, { limit: 10 });
      const last = rows.find((r) => r.action.includes('/admin/health'));
      expect(last?.actor).toBe('alice');
    } finally {
      await server.close();
    }
  });

  it('falls back to token-hash actor when X-Admin-Actor is malformed', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/health', headers: authHeaders('Capital Letters!'),
      });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      const rows = await adminAuditEventsRepo.search(pg.db, { limit: 10 });
      const last = rows.find((r) => r.action.includes('/admin/health'));
      // Token hash is 16 hex chars
      expect(last?.actor).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      await server.close();
    }
  });
});

// ── /admin/customers (search) ───────────────────────────────────────────────

describe('GET /admin/customers', () => {
  it('returns paginated customers ordered by createdAt desc', async () => {
    for (let i = 1; i <= 3; i++) {
      await customersRepo.insertCustomer(pg.db, {
        email: `cust-${i}@x.io`,
        tier: 'prepaid',
      });
    }
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?limit=10', headers: authHeaders('admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { customers: Array<{ email: string }> };
      expect(body.customers).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it('filters by q (email substring)', async () => {
    await customersRepo.insertCustomer(pg.db, { email: 'alice@example.com', tier: 'prepaid' });
    await customersRepo.insertCustomer(pg.db, { email: 'bob@example.com', tier: 'free' });
    await customersRepo.insertCustomer(pg.db, { email: 'carol@other.com', tier: 'prepaid' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?q=example', headers: authHeaders('admin'),
      });
      const body = res.json() as { customers: Array<{ email: string }> };
      expect(body.customers).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('filters by tier and status', async () => {
    await customersRepo.insertCustomer(pg.db, { email: 'a@x.io', tier: 'prepaid' });
    await customersRepo.insertCustomer(pg.db, { email: 'b@x.io', tier: 'free' });
    await customersRepo.insertCustomer(pg.db, { email: 'c@x.io', tier: 'free', status: 'suspended' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?tier=free&status=suspended', headers: authHeaders('admin'),
      });
      const body = res.json() as { customers: Array<{ email: string }> };
      expect(body.customers).toHaveLength(1);
      expect(body.customers[0]?.email).toBe('c@x.io');
    } finally {
      await server.close();
    }
  });

  it('rejects invalid tier with 400', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?tier=enterprise', headers: authHeaders('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

// ── /admin/customers/:id/api-keys ──────────────────────────────────────────

describe('Operator-issued customer API keys', () => {
  it('lists keys with hash never returned', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'k@x.io', tier: 'prepaid' });
    await apiKeysRepo.insertApiKey(pg.db, { customerId: c.id, hash: 'h1', label: 'test' });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: `/admin/customers/${c.id}/api-keys`, headers: authHeaders('admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      for (const k of body.keys) expect(Object.keys(k)).not.toContain('hash');
    } finally {
      await server.close();
    }
  });

  it('returns 404 for missing customer', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: `/admin/customers/00000000-0000-4000-8000-000000000000/api-keys`,
        headers: authHeaders('admin'),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('issues a key (returns cleartext exactly once)', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'issue@x.io', tier: 'prepaid' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST', url: `/admin/customers/${c.id}/api-keys`,
        headers: { ...authHeaders('admin'), 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'op-issued' }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; key: string; label: string };
      expect(body.label).toBe('op-issued');
      expect(body.key.startsWith('sk-test-')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('rejects empty label with 400', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'l@x.io', tier: 'prepaid' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST', url: `/admin/customers/${c.id}/api-keys`,
        headers: { ...authHeaders('admin'), 'content-type': 'application/json' },
        payload: JSON.stringify({ label: '' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

// ── /admin/audit ────────────────────────────────────────────────────────────

describe('GET /admin/audit', () => {
  it('returns recent audit events filtered by actor', async () => {
    const server = await buildServer();
    try {
      // Generate two requests as different actors
      await server.app.inject({ method: 'GET', url: '/admin/health', headers: authHeaders('alice') });
      await server.app.inject({ method: 'GET', url: '/admin/health', headers: authHeaders('bob') });
      await new Promise((r) => setTimeout(r, 80));

      const res = await server.app.inject({
        method: 'GET', url: '/admin/audit?actor=alice', headers: authHeaders('admin'),
      });
      const body = res.json() as { events: Array<{ actor: string }> };
      expect(body.events.length).toBeGreaterThan(0);
      for (const e of body.events) expect(e.actor).toBe('alice');
    } finally {
      await server.close();
    }
  });
});

// ── /admin/reservations ─────────────────────────────────────────────────────

describe('GET /admin/reservations', () => {
  it('lists open reservations ascending by created_at with age_seconds', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'r@x.io', tier: 'prepaid' });
    await reservationsRepo.insertReservation(pg.db, {
      customerId: c.id, workId: 'w-1', kind: 'prepaid', amountUsdCents: 100n, state: 'open',
      createdAt: new Date(Date.now() - 60_000),
    });
    await reservationsRepo.insertReservation(pg.db, {
      customerId: c.id, workId: 'w-2', kind: 'prepaid', amountUsdCents: 200n, state: 'open',
      createdAt: new Date(Date.now() - 30_000),
    });
    await reservationsRepo.insertReservation(pg.db, {
      customerId: c.id, workId: 'w-3', kind: 'prepaid', amountUsdCents: 300n, state: 'committed',
      createdAt: new Date(Date.now() - 10_000),
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/reservations?state=open&limit=10',
        headers: authHeaders('admin'),
      });
      const body = res.json() as { reservations: Array<{ work_id: string; age_seconds: number }> };
      expect(body.reservations).toHaveLength(2);
      expect(body.reservations[0]?.work_id).toBe('w-1'); // oldest first
      expect(body.reservations[0]?.age_seconds).toBeGreaterThanOrEqual(30);
    } finally {
      await server.close();
    }
  });
});

// ── /admin/topups ───────────────────────────────────────────────────────────

describe('GET /admin/topups', () => {
  it('searches topups by status', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 't@x.io', tier: 'prepaid' });
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_ok', amountUsdCents: 1000n, status: 'succeeded',
    });
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_fail', amountUsdCents: 500n, status: 'failed',
    });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/topups?status=failed', headers: authHeaders('admin'),
      });
      const body = res.json() as { topups: Array<{ stripe_session_id: string }> };
      expect(body.topups).toHaveLength(1);
      expect(body.topups[0]?.stripe_session_id).toBe('cs_fail');
    } finally {
      await server.close();
    }
  });

  it('searches topups by customer_id', async () => {
    const a = await customersRepo.insertCustomer(pg.db, { email: 'a@x.io', tier: 'prepaid' });
    const b = await customersRepo.insertCustomer(pg.db, { email: 'b@x.io', tier: 'prepaid' });
    await topupsRepo.insertTopup(pg.db, { customerId: a.id, stripeSessionId: 'cs_a', amountUsdCents: 500n, status: 'succeeded' });
    await topupsRepo.insertTopup(pg.db, { customerId: b.id, stripeSessionId: 'cs_b', amountUsdCents: 500n, status: 'succeeded' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: `/admin/topups?customer_id=${a.id}`, headers: authHeaders('admin'),
      });
      const body = res.json() as { topups: Array<{ stripe_session_id: string }> };
      expect(body.topups).toHaveLength(1);
      expect(body.topups[0]?.stripe_session_id).toBe('cs_a');
    } finally {
      await server.close();
    }
  });
});

// ── /admin/nodes/:id/events ─────────────────────────────────────────────────

describe('GET /admin/nodes/:id/events', () => {
  it('returns the event timeline for a node, newest first', async () => {
    await nodeHealthRepo.insertNodeHealthEvent(pg.db, {
      nodeId: 'n-1', kind: 'circuit_opened', detail: 'failure 1',
      occurredAt: new Date('2026-04-20T10:00:00Z'),
    });
    await nodeHealthRepo.insertNodeHealthEvent(pg.db, {
      nodeId: 'n-1', kind: 'circuit_closed', detail: null,
      occurredAt: new Date('2026-04-21T10:00:00Z'),
    });
    await nodeHealthRepo.insertNodeHealthEvent(pg.db, {
      nodeId: 'other', kind: 'circuit_opened', detail: null,
      occurredAt: new Date('2026-04-22T10:00:00Z'),
    });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/nodes/n-1/events?limit=10', headers: authHeaders('admin'),
      });
      const body = res.json() as { events: Array<{ kind: string; node_id: string }> };
      expect(body.events).toHaveLength(2);
      expect(body.events[0]?.kind).toBe('circuit_closed'); // newest first
      for (const e of body.events) expect(e.node_id).toBe('n-1');
    } finally {
      await server.close();
    }
  });
});

// ── /admin/config/nodes ─────────────────────────────────────────────────────

describe('GET /admin/config/nodes', () => {
  it('returns the loaded nodes.yaml with mtime + sha256', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/config/nodes', headers: authHeaders('admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        path: string; sha256: string; mtime: string; size_bytes: number;
        contents: string; loaded_nodes: Array<{ id: string }>;
      };
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.contents).toContain('node-search');
      expect(body.loaded_nodes.some((n) => n.id === 'node-search')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
