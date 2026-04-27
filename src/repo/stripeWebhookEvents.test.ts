import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '@cloud-spe/bridge-core/service/billing/testPg.js';
import { insertIfNew } from './stripeWebhookEvents.js';

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(sql`TRUNCATE TABLE stripe_webhook_event CASCADE`);
});

describe('stripeWebhookEvents.insertIfNew', () => {
  it('returns true on first insert, false on duplicate', async () => {
    const first = await insertIfNew(pg.db, 'evt_1', 'checkout.session.completed', '{}');
    expect(first).toBe(true);

    const second = await insertIfNew(pg.db, 'evt_1', 'checkout.session.completed', '{}');
    expect(second).toBe(false);
  });

  it('distinguishes different event ids', async () => {
    expect(await insertIfNew(pg.db, 'evt_a', 'x', '{}')).toBe(true);
    expect(await insertIfNew(pg.db, 'evt_b', 'x', '{}')).toBe(true);
  });
});
