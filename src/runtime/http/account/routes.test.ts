import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import * as apiKeysRepo from '../../../repo/apiKeys.js';
import * as topupsRepo from '../../../repo/topups.js';
import * as usageRecordsRepo from '../../../repo/usageRecords.js';
import { createAuthService, issueKey } from '../../../service/auth/index.js';
import { defaultRateLimitConfig } from '../../../config/rateLimit.js';
import { createFastifyServer } from '../../../providers/http/fastify.js';
import { registerAccountRoutes } from './routes.js';

let pg: TestPg;
const pepper = 'account-test-pepper-000';

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE api_key, reservation, usage_record, topup, stripe_webhook_event, customer CASCADE`,
  );
});

async function buildServer() {
  const authService = createAuthService({
    db: pg.db,
    config: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  const server = await createFastifyServer({ logger: false });
  registerAccountRoutes(server.app, {
    db: pg.db,
    authService,
    authConfig: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
    rateLimitConfig: defaultRateLimitConfig(),
  });
  await server.app.ready();
  return server;
}

async function seedCustomerAndKey(opts: { email?: string; tier?: 'free' | 'prepaid' } = {}) {
  const customer = await customersRepo.insertCustomer(pg.db, {
    email: opts.email ?? `acct-${Math.random().toString(36).slice(2)}@x.io`,
    tier: opts.tier ?? 'prepaid',
    balanceUsdCents: 1234n,
    quotaTokensRemaining: opts.tier === 'free' ? 50_000n : null,
    quotaResetAt: opts.tier === 'free' ? new Date('2026-05-01T00:00:00Z') : null,
  });
  const { plaintext, apiKeyId } = await issueKey(pg.db, {
    customerId: customer.id,
    envPrefix: 'test',
    pepper,
    label: 'first',
  });
  return { customer, plaintext, apiKeyId };
}

describe('GET /v1/account', () => {
  it('returns the authenticated customer summary in USD', async () => {
    const { customer, plaintext } = await seedCustomerAndKey({ email: 'acct@x.io', tier: 'free' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.id).toBe(customer.id);
      expect(body.email).toBe('acct@x.io');
      expect(body.tier).toBe('free');
      expect(body.status).toBe('active');
      expect(body.balance_usd).toBe('12.34');
      expect(body.reserved_usd).toBe('0.00');
      expect(body.free_tokens_remaining).toBe(50_000);
      expect(body.free_tokens_reset_at).toMatch(/^2026-05-01/);
    } finally {
      await server.close();
    }
  });

  it('returns 401 without auth', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/v1/account' });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/account/limits', () => {
  it('returns tier and rate-card values', async () => {
    const { plaintext } = await seedCustomerAndKey({ tier: 'free' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account/limits',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.tier).toBe('free');
      expect(typeof body.requests_per_minute).toBe('number');
      expect(typeof body.max_concurrent).toBe('number');
      expect(body.max_tokens_per_request).toBe(1024);
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/account/api-keys', () => {
  it('returns the calling customer\'s keys without hashes', async () => {
    const { customer, plaintext } = await seedCustomerAndKey();
    // Add a second key, revoke one
    const k2 = await apiKeysRepo.insertApiKey(pg.db, {
      customerId: customer.id,
      hash: 'h-second',
      label: 'second',
    });
    await apiKeysRepo.revoke(pg.db, k2.id, new Date());

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account/api-keys',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(2);
      // Hash never returned
      for (const k of body.keys) expect(Object.keys(k)).not.toContain('hash');
      const labels = body.keys.map((k) => k.label).sort();
      expect(labels).toEqual(['first', 'second']);
    } finally {
      await server.close();
    }
  });

  it('isolates per customer', async () => {
    const { plaintext: tokenA } = await seedCustomerAndKey({ email: 'iso-a@x.io' });
    await seedCustomerAndKey({ email: 'iso-b@x.io' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account/api-keys',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      const body = res.json() as { keys: Array<Record<string, unknown>> };
      // Only customer A's single key
      expect(body.keys).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('POST /v1/account/api-keys', () => {
  it('creates a new key, returns cleartext exactly once', async () => {
    const { customer, plaintext } = await seedCustomerAndKey();
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/account/api-keys',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'production' }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.label).toBe('production');
      expect(typeof body.key).toBe('string');
      expect((body.key as string).startsWith('sk-test-')).toBe(true);

      // Subsequent list does NOT echo the cleartext
      const list = await server.app.inject({
        method: 'GET',
        url: '/v1/account/api-keys',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      const listBody = list.json() as { keys: Array<Record<string, unknown>> };
      const created = listBody.keys.find((k) => k.id === body.id);
      expect(created).toBeDefined();
      expect(Object.keys(created!)).not.toContain('key');

      // Customer scoping: the new key belongs to the calling customer
      const persisted = await apiKeysRepo.findById(pg.db, body.id as string);
      expect(persisted?.customerId).toBe(customer.id);
    } finally {
      await server.close();
    }
  });

  it('rejects empty label with 400', async () => {
    const { plaintext } = await seedCustomerAndKey();
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/account/api-keys',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ label: '' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('rejects label over 64 chars with 400', async () => {
    const { plaintext } = await seedCustomerAndKey();
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/account/api-keys',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'x'.repeat(65) }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('DELETE /v1/account/api-keys/:id', () => {
  it('revokes a non-self key, returns 204', async () => {
    const { customer, plaintext } = await seedCustomerAndKey();
    const second = await apiKeysRepo.insertApiKey(pg.db, {
      customerId: customer.id,
      hash: 'h-revoke',
      label: 'doomed',
    });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'DELETE',
        url: `/v1/account/api-keys/${second.id}`,
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(204);
      const persisted = await apiKeysRepo.findById(pg.db, second.id);
      expect(persisted?.revokedAt).toBeInstanceOf(Date);
    } finally {
      await server.close();
    }
  });

  it('refuses to revoke the request\'s own key with 412', async () => {
    const { plaintext, apiKeyId } = await seedCustomerAndKey();
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'DELETE',
        url: `/v1/account/api-keys/${apiKeyId}`,
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(412);
      const body = res.json() as { error: { type: string } };
      expect(body.error.type).toBe('CannotRevokeSelf');
      // The key is still active
      const persisted = await apiKeysRepo.findById(pg.db, apiKeyId);
      expect(persisted?.revokedAt).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('refuses to revoke another customer\'s key with 404', async () => {
    const { plaintext: tokenA } = await seedCustomerAndKey({ email: 'rev-a@x.io' });
    const { apiKeyId: keyB } = await seedCustomerAndKey({ email: 'rev-b@x.io' });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'DELETE',
        url: `/v1/account/api-keys/${keyB}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(404);
      // B's key is still active
      const persisted = await apiKeysRepo.findById(pg.db, keyB);
      expect(persisted?.revokedAt).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('rejects non-uuid id with 400', async () => {
    const { plaintext } = await seedCustomerAndKey();
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'DELETE',
        url: `/v1/account/api-keys/not-a-uuid`,
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/account/usage', () => {
  it('returns rolled-up usage with totals', async () => {
    const { customer, plaintext } = await seedCustomerAndKey();
    await usageRecordsRepo.insertUsageRecord(pg.db, {
      customerId: customer.id,
      workId: 'w-1',
      kind: 'chat',
      model: 'gpt-4o',
      nodeUrl: 'http://node',
      promptTokensReported: 100,
      completionTokensReported: 50,
      costUsdCents: 10n,
      nodeCostWei: '0',
      status: 'success',
    });
    await usageRecordsRepo.insertUsageRecord(pg.db, {
      customerId: customer.id,
      workId: 'w-2',
      kind: 'chat',
      model: 'gpt-4o-mini',
      nodeUrl: 'http://node',
      promptTokensReported: 200,
      completionTokensReported: 75,
      costUsdCents: 5n,
      nodeCostWei: '0',
      status: 'success',
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account/usage?group_by=model',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        rows: Array<{ bucket: string; requests: number; cost_usd: string }>;
        totals: { requests: number; cost_usd: string };
      };
      expect(body.rows).toHaveLength(2);
      expect(body.totals.requests).toBe(2);
      expect(body.totals.cost_usd).toBe('0.15');
    } finally {
      await server.close();
    }
  });

  it('rejects invalid group_by with 400', async () => {
    const { plaintext } = await seedCustomerAndKey();
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account/usage?group_by=bogus',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/account/topups (cursor edges)', () => {
  it('returns next_cursor when a full page is filled, ignores garbage cursor on next request', async () => {
    const { customer, plaintext } = await seedCustomerAndKey();
    for (let i = 1; i <= 5; i++) {
      await topupsRepo.insertTopup(pg.db, {
        customerId: customer.id,
        stripeSessionId: `cs_full_${i}`,
        amountUsdCents: BigInt(i * 100),
        status: 'succeeded',
        createdAt: new Date(`2026-04-${10 + i}T10:00:00Z`),
      });
    }
    const server = await buildServer();
    try {
      // limit=2 forces a partial page → next_cursor populated
      const page1 = await server.app.inject({
        method: 'GET',
        url: '/v1/account/topups?limit=2',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      const body1 = page1.json() as { topups: unknown[]; next_cursor: string | null };
      expect(body1.topups).toHaveLength(2);
      expect(body1.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);

      // garbage cursor → decodeCursor returns undefined → first page again
      const garbage = await server.app.inject({
        method: 'GET',
        url: '/v1/account/topups?limit=2&cursor=this-is-not-base64url-of-iso',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(garbage.statusCode).toBe(200);
      const garbageBody = garbage.json() as { topups: unknown[] };
      expect(garbageBody.topups).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('formatUsd handles a negative reserved balance (admin-pushed correction)', async () => {
    // Insert a customer with a negative reserved balance to force the
    // negative branch of formatUsd.
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'neg@x.io',
      tier: 'prepaid',
      balanceUsdCents: 0n,
      reservedUsdCents: -50n,
    });
    const { plaintext } = await issueKey(pg.db, {
      customerId: customer.id,
      envPrefix: 'test',
      pepper,
      label: 'neg',
    });
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { reserved_usd: string };
      expect(body.reserved_usd).toBe('-0.50');
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/account/topups', () => {
  it('returns paginated topups for the calling customer', async () => {
    const { customer, plaintext } = await seedCustomerAndKey();
    for (let i = 1; i <= 3; i++) {
      await topupsRepo.insertTopup(pg.db, {
        customerId: customer.id,
        stripeSessionId: `cs_${i}`,
        amountUsdCents: BigInt(i * 1000),
        status: i === 3 ? 'pending' : 'succeeded',
      });
    }
    // Another customer's topups must not leak
    const other = await customersRepo.insertCustomer(pg.db, {
      email: 'other@x.io',
      tier: 'prepaid',
    });
    await topupsRepo.insertTopup(pg.db, {
      customerId: other.id,
      stripeSessionId: 'cs_leak',
      amountUsdCents: 99999n,
      status: 'succeeded',
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/v1/account/topups?limit=10',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        topups: Array<{ stripe_session_id: string; amount_usd: string }>;
        next_cursor: string | null;
      };
      expect(body.topups).toHaveLength(3);
      expect(body.topups.some((t) => t.stripe_session_id === 'cs_leak')).toBe(false);
      expect(body.topups[0]?.amount_usd).toBe('30.00');
    } finally {
      await server.close();
    }
  });
});
