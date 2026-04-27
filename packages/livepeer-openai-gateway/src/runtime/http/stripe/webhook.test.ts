import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { registerStripeWebhookRoute } from './webhook.js';
import type { StripeClient, StripeEventMinimal } from '../../../providers/stripe.js';

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.stripe_webhook_events, app.customers CASCADE`,
  );
});

const WEBHOOK_SECRET = 'whsec_test_1234567890';

function signPayload(
  payload: string,
  secret = WEBHOOK_SECRET,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

// Our test stripe client parses the signature header and the payload, and if
// the signature matches, returns a StripeEventMinimal from the JSON body.
function createTestStripeClient(secret = WEBHOOK_SECRET): StripeClient {
  return {
    async createCheckoutSession() {
      throw new Error('not used in webhook tests');
    },
    constructEvent(rawBody, signature): StripeEventMinimal {
      const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const parts = Object.fromEntries(
        signature.split(',').map((kv) => {
          const [k, v] = kv.split('=');
          return [k!, v!];
        }),
      );
      const expected = createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
      if (expected !== parts.v1) throw new Error('signature mismatch');
      const parsed = JSON.parse(payload) as StripeEventMinimal;
      return parsed;
    },
  };
}

async function buildServer() {
  const server = await createFastifyServer({ logger: false });
  registerStripeWebhookRoute(server.app, { db: pg.db, stripe: createTestStripeClient() });
  await server.app.ready();
  return server;
}

describe('POST /v1/stripe/webhook', () => {
  it('credits balance + upgrades tier on checkout.session.completed', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'whfree@x.io',
      tier: 'free',
      quotaTokensRemaining: 1_000n,
      quotaMonthlyAllowance: 1_000n,
    });

    const event: StripeEventMinimal = {
      id: 'evt_whtest_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_xyz',
          client_reference_id: customer.id,
          amount_total: 2500,
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = signPayload(payload);

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(200);

      const after = await customersRepo.findById(pg.db, customer.id);
      expect(after!.balanceUsdCents).toBe(2500n);
      expect(after!.tier).toBe('prepaid');
    } finally {
      await server.close();
    }
  });

  it('returns 400 on signature mismatch and does not write state', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'whbad@x.io',
      tier: 'free',
    });
    const event: StripeEventMinimal = {
      id: 'evt_whtest_bad',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_bad',
          client_reference_id: customer.id,
          amount_total: 1000,
        },
      },
    };

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'stripe-signature': 't=0,v1=deadbeef', 'content-type': 'application/json' },
        payload: JSON.stringify(event),
      });
      expect(res.statusCode).toBe(400);

      const after = await customersRepo.findById(pg.db, customer.id);
      expect(after!.balanceUsdCents).toBe(0n);
    } finally {
      await server.close();
    }
  });

  it('idempotent: replayed event does not double-credit', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'whidem@x.io',
      tier: 'prepaid',
      balanceUsdCents: 100n,
    });
    const event: StripeEventMinimal = {
      id: 'evt_whtest_replay',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_replay',
          client_reference_id: customer.id,
          amount_total: 1500,
        },
      },
    };
    const payload = JSON.stringify(event);

    const server = await buildServer();
    try {
      const sig1 = signPayload(payload);
      const res1 = await server.app.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'stripe-signature': sig1, 'content-type': 'application/json' },
        payload,
      });
      expect(res1.statusCode).toBe(200);

      const sig2 = signPayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) + 1);
      const res2 = await server.app.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json()).toMatchObject({ status: 'duplicate_ignored' });

      const after = await customersRepo.findById(pg.db, customer.id);
      expect(after!.balanceUsdCents).toBe(1600n);
    } finally {
      await server.close();
    }
  });

  it('charge.dispute.created marks the topup disputed', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'whdisp@x.io',
      tier: 'prepaid',
    });
    // Seed a topup.
    await (
      await import('../../../service/billing/topups.js')
    ).creditTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_test_disp_flow',
      amountUsdCents: 500n,
    });
    const event: StripeEventMinimal = {
      id: 'evt_whtest_disp',
      type: 'charge.dispute.created',
      data: {
        object: {
          metadata: { stripe_session_id: 'cs_test_disp_flow' },
        },
      },
    };
    const payload = JSON.stringify(event);

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'stripe-signature': signPayload(payload), 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(200);
      const { findTopupBySession } = await import('../../../service/billing/topups.js');
      const row = await findTopupBySession(pg.db, 'cs_test_disp_flow');
      expect(row!.disputedAt).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});
