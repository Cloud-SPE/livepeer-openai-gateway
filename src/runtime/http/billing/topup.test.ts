import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { createAuthService, issueKey } from '../../../service/auth/index.js';
import { createFastifyServer } from '../../../providers/http/fastify.js';
import { registerTopupRoute } from './topup.js';
import type { StripeClient } from '../../../providers/stripe.js';

let pg: TestPg;

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

const pepper = 'topup-test-pepper-000';

function mockStripeClient(): StripeClient & { calls: number } {
  const client: StripeClient & { calls: number } = {
    calls: 0,
    async createCheckoutSession(input) {
      client.calls++;
      return {
        sessionId: `cs_mock_${client.calls}`,
        url: `https://checkout.stripe.com/c/pay/cs_mock_${client.calls}?amount=${input.amountUsdCents}`,
      };
    },
    constructEvent() {
      throw new Error('not used');
    },
  };
  return client;
}

async function buildServer() {
  const authService = createAuthService({
    db: pg.db,
    config: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  const stripe = mockStripeClient();
  const server = await createFastifyServer({ logger: false });
  registerTopupRoute(server.app, {
    authService,
    stripe,
    config: {
      secretKey: 'sk_test',
      webhookSecret: 'whsec_test',
      priceMinCents: 500,
      priceMaxCents: 50_000,
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    },
  });
  await server.app.ready();
  return { server, stripe };
}

describe('POST /v1/billing/topup', () => {
  it('returns a Stripe Checkout URL for a valid amount', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'topup@x.io',
      tier: 'prepaid',
    });
    const { plaintext } = await issueKey(pg.db, {
      customerId: customer.id,
      envPrefix: 'test',
      pepper,
    });
    const { server, stripe } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/billing/topup',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ amount_usd_cents: 2500 }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { url: string };
      expect(body.url).toMatch(/checkout\.stripe\.com/);
      expect(stripe.calls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('rejects amounts below the configured minimum', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'low@x.io',
      tier: 'prepaid',
    });
    const { plaintext } = await issueKey(pg.db, {
      customerId: customer.id,
      envPrefix: 'test',
      pepper,
    });
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/billing/topup',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ amount_usd_cents: 100 }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('rejects amounts above the configured maximum', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'hi@x.io',
      tier: 'prepaid',
    });
    const { plaintext } = await issueKey(pg.db, {
      customerId: customer.id,
      envPrefix: 'test',
      pepper,
    });
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/billing/topup',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ amount_usd_cents: 1_000_000 }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('rejects when body is missing required field', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'bad@x.io',
      tier: 'prepaid',
    });
    const { plaintext } = await issueKey(pg.db, {
      customerId: customer.id,
      envPrefix: 'test',
      pepper,
    });
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/billing/topup',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('returns 401 without auth', async () => {
    const { server } = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/billing/topup',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ amount_usd_cents: 2500 }),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});
