import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../service/billing/testPg.js';
import * as customersRepo from './customers.js';
import * as reservationsRepo from './reservations.js';
import * as topupsRepo from './topups.js';
import * as usageRecordsRepo from './usageRecords.js';

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});

afterAll(async () => {
  if (pg) await pg.close();
});

beforeEach(async () => {
  await pg.db.execute(sql`TRUNCATE TABLE reservation, usage_record, topup, customer CASCADE`);
});

async function seed(): Promise<string> {
  const row = await customersRepo.insertCustomer(pg.db, {
    email: `repo-${Math.random().toString(36).slice(2)}@x.io`,
    apiKeyHash: `hash-${Math.random().toString(36).slice(2)}`,
    tier: 'prepaid',
    balanceUsdCents: 500n,
  });
  return row.id;
}

describe('repo/customers', () => {
  it('findById returns a row and null when missing', async () => {
    const id = await seed();
    const found = await customersRepo.findById(pg.db, id);
    expect(found?.id).toBe(id);

    const missing = await customersRepo.findById(pg.db, '00000000-0000-4000-8000-000000000000');
    expect(missing).toBeNull();
  });

  it('findByApiKeyHash finds the row and returns null when missing', async () => {
    const row = await customersRepo.insertCustomer(pg.db, {
      email: 'hash@x.io',
      apiKeyHash: 'k-unique',
      tier: 'free',
    });
    const found = await customersRepo.findByApiKeyHash(pg.db, 'k-unique');
    expect(found?.id).toBe(row.id);

    const missing = await customersRepo.findByApiKeyHash(pg.db, 'not-there');
    expect(missing).toBeNull();
  });

  it('selectForUpdate returns null when id is missing', async () => {
    const missing = await customersRepo.selectForUpdate(
      pg.db,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(missing).toBeNull();
  });

  it('incrementBalance adds the delta atomically', async () => {
    const id = await seed();
    await customersRepo.incrementBalance(pg.db, id, 250n);
    const after = await customersRepo.findById(pg.db, id);
    expect(after?.balanceUsdCents).toBe(750n);
  });

  it('updateQuotaFields updates named columns', async () => {
    const row = await customersRepo.insertCustomer(pg.db, {
      email: 'q@x.io',
      apiKeyHash: 'q',
      tier: 'free',
      quotaTokensRemaining: 100n,
    });
    await customersRepo.updateQuotaFields(pg.db, row.id, { quotaTokensRemaining: 42n });
    const after = await customersRepo.findById(pg.db, row.id);
    expect(after?.quotaTokensRemaining).toBe(42n);
  });
});

describe('repo/reservations', () => {
  it('findById returns null for a missing id', async () => {
    const missing = await reservationsRepo.findById(pg.db, '00000000-0000-4000-8000-000000000000');
    expect(missing).toBeNull();
  });
});

describe('repo/topups', () => {
  it('insertTopup + updateTopupStatus round-trip', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 't@x.io',
      apiKeyHash: 't',
      tier: 'prepaid',
    });
    const inserted = await topupsRepo.insertTopup(pg.db, {
      customerId: customer.id,
      stripeSessionId: 'cs_t_1',
      amountUsdCents: 1000n,
      status: 'pending',
    });
    expect(inserted.status).toBe('pending');

    await topupsRepo.updateTopupStatus(pg.db, 'cs_t_1', 'succeeded');
    // No fetch helper; verify via billing's reliance is indirect. Here we just
    // assert the update didn't throw; a dedicated getter is out of 0003 scope.
  });
});

describe('repo/usageRecords', () => {
  it('insertUsageRecord stores a record', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'u@x.io',
      apiKeyHash: 'u',
      tier: 'prepaid',
    });
    const rec = await usageRecordsRepo.insertUsageRecord(pg.db, {
      customerId: customer.id,
      workId: 'w-u',
      model: 'model-small',
      nodeUrl: 'https://node.example',
      promptTokensReported: 10,
      completionTokensReported: 20,
      costUsdCents: 5n,
      nodeCostWei: '100000000',
      status: 'success',
    });
    expect(rec.workId).toBe('w-u');
  });
});
