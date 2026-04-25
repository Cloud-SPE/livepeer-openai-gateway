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
  await pg.db.execute(
    sql`TRUNCATE TABLE api_key, reservation, usage_record, topup, customer CASCADE`,
  );
});

async function seed(): Promise<string> {
  const row = await customersRepo.insertCustomer(pg.db, {
    email: `repo-${Math.random().toString(36).slice(2)}@x.io`,
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
  });
});

describe('repo/usageRecords', () => {
  it('insertUsageRecord stores a chat record with defaulted kind', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'u@x.io',
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
    expect(rec.kind).toBe('chat');
  });

  it('insertUsageRecord stores an embeddings record (completion_tokens null)', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'u-emb@x.io',
      tier: 'prepaid',
    });
    const rec = await usageRecordsRepo.insertUsageRecord(pg.db, {
      customerId: customer.id,
      workId: 'w-emb',
      kind: 'embeddings',
      model: 'text-embedding-3-small',
      nodeUrl: 'https://node.example',
      promptTokensReported: 42,
      costUsdCents: 1n,
      nodeCostWei: '1000',
      status: 'success',
    });
    expect(rec.kind).toBe('embeddings');
    expect(rec.completionTokensReported).toBeNull();
  });

  it('insertUsageRecord stores an images record (token columns null)', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'u-img@x.io',
      tier: 'prepaid',
    });
    const rec = await usageRecordsRepo.insertUsageRecord(pg.db, {
      customerId: customer.id,
      workId: 'w-img',
      kind: 'images',
      model: 'dall-e-3',
      nodeUrl: 'https://node.example',
      imageCount: 2,
      costUsdCents: 10n,
      nodeCostWei: '500000',
      status: 'success',
    });
    expect(rec.kind).toBe('images');
    expect(rec.imageCount).toBe(2);
    expect(rec.promptTokensReported).toBeNull();
  });

  it('insertUsageRecord rejects kind/column mismatch via CHECK constraint', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'u-bad@x.io',
      tier: 'prepaid',
    });
    await expect(
      usageRecordsRepo.insertUsageRecord(pg.db, {
        customerId: customer.id,
        workId: 'w-bad',
        kind: 'images',
        model: 'dall-e-3',
        nodeUrl: 'https://node.example',
        // imageCount intentionally missing — CHECK should reject
        costUsdCents: 10n,
        nodeCostWei: '500000',
        status: 'success',
      }),
    ).rejects.toThrow();
  });
});
