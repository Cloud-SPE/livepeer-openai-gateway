import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../service/billing/testPg.js';
import * as apiKeysRepo from './apiKeys.js';
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

  it('findByCustomer paginates desc by createdAt with cursor', async () => {
    const a = await customersRepo.insertCustomer(pg.db, { email: 'pa@x.io', tier: 'prepaid' });
    const b = await customersRepo.insertCustomer(pg.db, { email: 'pb@x.io', tier: 'prepaid' });

    // Insert with manual createdAt to control ordering
    for (let i = 1; i <= 5; i++) {
      await topupsRepo.insertTopup(pg.db, {
        customerId: a.id,
        stripeSessionId: `cs_a_${i}`,
        amountUsdCents: BigInt(i * 1000),
        status: 'succeeded',
        createdAt: new Date(`2026-04-${10 + i}T10:00:00Z`),
      });
    }
    await topupsRepo.insertTopup(pg.db, {
      customerId: b.id,
      stripeSessionId: 'cs_b_1',
      amountUsdCents: 9999n,
      status: 'succeeded',
    });

    const page1 = await topupsRepo.findByCustomer(pg.db, a.id, { limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]?.stripeSessionId).toBe('cs_a_5');
    expect(page1[1]?.stripeSessionId).toBe('cs_a_4');

    const cursor = page1[1]?.createdAt;
    expect(cursor).toBeInstanceOf(Date);
    const page2 = await topupsRepo.findByCustomer(pg.db, a.id, {
      limit: 2,
      cursorCreatedAt: cursor!,
    });
    expect(page2).toHaveLength(2);
    expect(page2[0]?.stripeSessionId).toBe('cs_a_3');
    expect(page2[1]?.stripeSessionId).toBe('cs_a_2');

    // Customer isolation — b's row never appears in a's pages
    const all = [...page1, ...page2];
    expect(all.some((r) => r.stripeSessionId === 'cs_b_1')).toBe(false);
  });

  it('findByCustomer returns empty for unknown customer', async () => {
    const rows = await topupsRepo.findByCustomer(pg.db, '00000000-0000-4000-8000-000000000000', {
      limit: 10,
    });
    expect(rows).toEqual([]);
  });
});

describe('repo/apiKeys (extensions)', () => {
  it('findByCustomer returns all keys (active + revoked) sorted desc', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'ka@x.io',
      tier: 'prepaid',
    });
    const k1 = await apiKeysRepo.insertApiKey(pg.db, {
      customerId: customer.id,
      hash: 'hash-1',
      label: 'old',
    });
    const k2 = await apiKeysRepo.insertApiKey(pg.db, {
      customerId: customer.id,
      hash: 'hash-2',
      label: 'newer',
    });
    await apiKeysRepo.revoke(pg.db, k1.id, new Date());

    const rows = await apiKeysRepo.findByCustomer(pg.db, customer.id);
    expect(rows).toHaveLength(2);
    // Newer first
    expect(rows[0]?.id).toBe(k2.id);
    expect(rows[0]?.revokedAt).toBeNull();
    expect(rows[1]?.id).toBe(k1.id);
    expect(rows[1]?.revokedAt).toBeInstanceOf(Date);
  });

  it('countActiveByCustomer excludes revoked keys', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'kc@x.io',
      tier: 'prepaid',
    });
    const k1 = await apiKeysRepo.insertApiKey(pg.db, { customerId: customer.id, hash: 'h-c-1' });
    await apiKeysRepo.insertApiKey(pg.db, { customerId: customer.id, hash: 'h-c-2' });
    await apiKeysRepo.insertApiKey(pg.db, { customerId: customer.id, hash: 'h-c-3' });
    await apiKeysRepo.revoke(pg.db, k1.id, new Date());

    expect(await apiKeysRepo.countActiveByCustomer(pg.db, customer.id)).toBe(2);
  });

  it('findByCustomer isolates per customer', async () => {
    const a = await customersRepo.insertCustomer(pg.db, { email: 'iso-a@x.io', tier: 'prepaid' });
    const b = await customersRepo.insertCustomer(pg.db, { email: 'iso-b@x.io', tier: 'prepaid' });
    await apiKeysRepo.insertApiKey(pg.db, { customerId: a.id, hash: 'iso-h-a' });
    await apiKeysRepo.insertApiKey(pg.db, { customerId: b.id, hash: 'iso-h-b' });

    const rowsA = await apiKeysRepo.findByCustomer(pg.db, a.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.hash).toBe('iso-h-a');
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
