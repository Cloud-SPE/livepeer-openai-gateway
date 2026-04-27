import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from './testPg.js';
import * as customersRepo from '../../repo/customers.js';
import { creditTopup, findTopupBySession, markTopupDisputed } from './topups.js';

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.stripe_webhook_events, engine.node_health_events, engine.node_health, app.customers CASCADE`,
  );
});

describe('creditTopup', () => {
  it('credits balance and upgrades free → prepaid on first top-up', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: `free-${Math.random().toString(36).slice(2)}@x.io`,
      tier: 'free',
      quotaTokensRemaining: 1_000n,
      quotaMonthlyAllowance: 1_000n,
    });

    const result = await creditTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_test_first',
      amountUsdCents: 2500n,
    });
    expect(result.upgradedFromFree).toBe(true);
    expect(result.newBalanceUsdCents).toBe(2500n);

    const after = await customersRepo.findById(pg.db, customer.id);
    expect(after!.tier).toBe('prepaid');
    expect(after!.balanceUsdCents).toBe(2500n);
    expect(after!.rateLimitTier).toBe('prepaid-default');
  });

  it('is additive on subsequent top-ups and does not re-flag upgrade', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: `p-${Math.random().toString(36).slice(2)}@x.io`,
      tier: 'prepaid',
      balanceUsdCents: 100n,
    });
    const result = await creditTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_test_second',
      amountUsdCents: 300n,
    });
    expect(result.upgradedFromFree).toBe(false);
    expect(result.newBalanceUsdCents).toBe(400n);
  });
});

describe('markTopupDisputed + findTopupBySession', () => {
  it('sets disputed_at and is findable afterwards', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: `d-${Math.random().toString(36).slice(2)}@x.io`,
      tier: 'prepaid',
    });
    await creditTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_test_disp',
      amountUsdCents: 500n,
    });
    const marked = await markTopupDisputed(pg.db, 'cs_test_disp');
    expect(marked).toBe(true);

    const row = await findTopupBySession(pg.db, 'cs_test_disp');
    expect(row!.disputedAt).not.toBeNull();
  });

  it('returns false when the session is unknown', async () => {
    const marked = await markTopupDisputed(pg.db, 'cs_test_unknown');
    expect(marked).toBe(false);
  });
});
