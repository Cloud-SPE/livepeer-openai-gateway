// Sad-path / edge-case coverage for the new /admin/* routes added in 0023.
// Focused on the validation branches and conditional-spread paths that the
// happy-path test (admin-search.test.ts) doesn't exercise.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '@cloud-spe/bridge-core/service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import * as topupsRepo from '../../../repo/topups.js';
import { CircuitBreaker } from '@cloud-spe/bridge-core/service/routing/circuitBreaker.js';
import { createNodeIndex } from '@cloud-spe/bridge-core/service/routing/nodeIndex.js';
import { createFastifyServer } from '@cloud-spe/bridge-core/providers/http/fastify.js';
import { createAdminService } from '../../../service/admin/index.js';
import { registerAdminRoutes } from './routes.js';
import type { PayerDaemonClient } from '@cloud-spe/bridge-core/providers/payerDaemon.js';

let pg: TestPg;
const ADMIN_TOKEN = 'a'.repeat(40);

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

async function buildServer() {
  const nodeIndex = createNodeIndex([
    { id: 'node-b', url: 'http://127.0.0.1:9999', capabilities: ['chat'], weight: 100 },
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
    config: { token: ADMIN_TOKEN, ipAllowlist: [] },
    adminService,
    authConfig: { pepper: 'branch-pepper-000', envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  await server.app.ready();
  return server;
}

const auth = (actor?: string) => ({
  'x-admin-token': ADMIN_TOKEN,
  ...(actor ? { 'x-admin-actor': actor } : {}),
});

beforeAll(async () => { pg = await startTestPg(); });
afterAll(async () => { if (pg) await pg.close(); });
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE admin_audit_event, api_key, reservation, usage_record, topup, stripe_webhook_event, node_health_event, node_health, customer CASCADE`,
  );
});

describe('admin routes — validation rejections', () => {
  it('GET /admin/customers rejects an out-of-range limit', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?limit=9999', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('GET /admin/customers/:id/api-keys rejects non-uuid id', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers/not-a-uuid/api-keys', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('POST /admin/customers/:id/api-keys rejects non-uuid id (no body parsed)', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST', url: '/admin/customers/not-a-uuid/api-keys',
        headers: { ...auth('admin'), 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'x' }),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('POST /admin/customers/:id/api-keys rejects missing body', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, { email: 'a@x.io', tier: 'prepaid' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST', url: `/admin/customers/${customer.id}/api-keys`,
        headers: { ...auth('admin'), 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('POST /admin/customers/:id/api-keys returns 404 for unknown customer', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST', url: `/admin/customers/00000000-0000-4000-8000-000000000000/api-keys`,
        headers: { ...auth('admin'), 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'x' }),
      });
      expect(res.statusCode).toBe(404);
    } finally { await server.close(); }
  });

  it('GET /admin/audit rejects out-of-range limit', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/audit?limit=-1', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('GET /admin/audit silently drops malformed from/to dates (treated as missing)', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/audit?from=not-a-date&to=also-not&limit=10',
        headers: auth('admin'),
      });
      // The validators accept any string; parseOptionalIsoDate returns undefined,
      // so the query runs without filters. Should be 200 with whatever events exist.
      expect(res.statusCode).toBe(200);
    } finally { await server.close(); }
  });

  it('GET /admin/audit accepts valid from/to and applies them', async () => {
    const server = await buildServer();
    try {
      // Generate an event in the window
      await server.app.inject({ method: 'GET', url: '/admin/health', headers: auth('alice') });
      await new Promise((r) => setTimeout(r, 60));

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await server.app.inject({
        method: 'GET',
        url: `/admin/audit?from=${encodeURIComponent(yesterday)}&to=${encodeURIComponent(tomorrow)}&limit=50`,
        headers: auth('admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { events: unknown[] };
      expect(body.events.length).toBeGreaterThan(0);
    } finally { await server.close(); }
  });

  it('GET /admin/reservations rejects invalid state', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/reservations?state=bogus', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('GET /admin/topups rejects invalid customer_id (non-uuid)', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/topups?customer_id=not-a-uuid', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

  it('GET /admin/topups accepts from/to filters and returns a window', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 't@x.io', tier: 'prepaid' });
    const inWindow = new Date('2026-04-20T12:00:00Z');
    const beforeWindow = new Date('2026-04-19T12:00:00Z');
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_in', amountUsdCents: 100n, status: 'succeeded', createdAt: inWindow,
    });
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_before', amountUsdCents: 50n, status: 'succeeded', createdAt: beforeWindow,
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/topups?from=2026-04-20T00:00:00Z&to=2026-04-21T00:00:00Z',
        headers: auth('admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { topups: Array<{ stripe_session_id: string }> };
      expect(body.topups).toHaveLength(1);
      expect(body.topups[0]?.stripe_session_id).toBe('cs_in');
    } finally { await server.close(); }
  });

  it('GET /admin/nodes/:id/events rejects out-of-range limit', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/nodes/foo/events?limit=99999', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(400);
    } finally { await server.close(); }
  });

});

describe('admin routes — repo branch coverage', () => {
  it('GET /admin/topups with no filters returns all rows (empty conds branch)', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'all@x.io', tier: 'prepaid' });
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_a', amountUsdCents: 100n, status: 'succeeded',
    });
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_b', amountUsdCents: 200n, status: 'failed',
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/topups', headers: auth('admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { topups: unknown[] };
      expect(body.topups).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('GET /admin/topups with all filters at once exercises the AND branch', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'multi@x.io', tier: 'prepaid' });
    await topupsRepo.insertTopup(pg.db, {
      customerId: c.id, stripeSessionId: 'cs_match',
      amountUsdCents: 100n, status: 'succeeded',
      createdAt: new Date('2026-04-20T10:00:00Z'),
    });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url:
          `/admin/topups?customer_id=${c.id}` +
          `&status=succeeded` +
          `&from=2026-04-19T00:00:00Z` +
          `&to=2026-04-21T00:00:00Z`,
        headers: auth('admin'),
      });
      const body = res.json() as { topups: unknown[] };
      expect(body.topups).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('GET /admin/reservations with cursor exercises the cursor branch', async () => {
    const c = await customersRepo.insertCustomer(pg.db, { email: 'curres@x.io', tier: 'prepaid' });
    const reservationsRepo = await import('../../../repo/reservations.js');
    for (let i = 0; i < 3; i++) {
      await reservationsRepo.insertReservation(pg.db, {
        customerId: c.id, workId: `cur-w-${i}`, kind: 'prepaid', amountUsdCents: BigInt(100 + i),
        state: 'open', createdAt: new Date(`2026-04-${20 + i}T10:00:00Z`),
      });
    }
    const server = await buildServer();
    try {
      const page1 = await server.app.inject({
        method: 'GET', url: '/admin/reservations?state=open&limit=2', headers: auth('admin'),
      });
      const body1 = page1.json() as { reservations: unknown[]; next_cursor: string | null };
      expect(body1.reservations).toHaveLength(2);
      expect(body1.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);

      const page2 = await server.app.inject({
        method: 'GET',
        url: `/admin/reservations?state=open&limit=2&cursor=${body1.next_cursor}`,
        headers: auth('admin'),
      });
      expect(page2.statusCode).toBe(200);
    } finally { await server.close(); }
  });
});

describe('admin routes — cursor / pagination edges', () => {
  it('GET /admin/customers next_cursor is null when fewer rows than limit', async () => {
    await customersRepo.insertCustomer(pg.db, { email: 'p1@x.io', tier: 'prepaid' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?limit=10', headers: auth('admin'),
      });
      const body = res.json() as { customers: unknown[]; next_cursor: string | null };
      expect(body.customers).toHaveLength(1);
      expect(body.next_cursor).toBeNull();
    } finally { await server.close(); }
  });

  it('GET /admin/customers next_cursor is a base64url string when a full page returns', async () => {
    for (let i = 0; i < 3; i++) {
      await customersRepo.insertCustomer(pg.db, { email: `p${i}@x.io`, tier: 'prepaid' });
    }
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET', url: '/admin/customers?limit=2', headers: auth('admin'),
      });
      const body = res.json() as { customers: unknown[]; next_cursor: string | null };
      expect(body.customers).toHaveLength(2);
      expect(body.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally { await server.close(); }
  });

  it('GET /admin/customers ignores garbage cursor and returns the first page', async () => {
    await customersRepo.insertCustomer(pg.db, { email: 'cur@x.io', tier: 'prepaid' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/admin/customers?limit=10&cursor=this-is-not-base64url-of-an-iso',
        headers: auth('admin'),
      });
      // decodeCursor returns undefined → no cursor filter applied
      expect(res.statusCode).toBe(200);
      const body = res.json() as { customers: unknown[] };
      expect(body.customers).toHaveLength(1);
    } finally { await server.close(); }
  });
});
