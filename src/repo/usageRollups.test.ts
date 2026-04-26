import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../service/billing/testPg.js';
import * as customersRepo from './customers.js';
import * as usageRecordsRepo from './usageRecords.js';
import { rollup } from './usageRollups.js';

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

async function seedCustomer(email = 'rollup@x.io'): Promise<string> {
  const row = await customersRepo.insertCustomer(pg.db, { email, tier: 'prepaid' });
  return row.id;
}

async function seedRecord(input: {
  customerId: string;
  workId: string;
  createdAt: Date;
  kind?: 'chat' | 'embeddings' | 'images' | 'speech' | 'transcriptions';
  model?: string;
  promptLocal?: number;
  completionLocal?: number;
  promptReported?: number;
  completionReported?: number;
  costCents: bigint;
  status?: 'success' | 'partial' | 'failed';
}): Promise<void> {
  const kind = input.kind ?? 'chat';
  const tokenCols =
    kind === 'chat'
      ? {
          promptTokensReported: input.promptReported ?? input.promptLocal ?? 100,
          completionTokensReported: input.completionReported ?? input.completionLocal ?? 50,
        }
      : kind === 'embeddings'
        ? { promptTokensReported: input.promptReported ?? input.promptLocal ?? 100 }
        : kind === 'images'
          ? { imageCount: 1 }
          : kind === 'speech'
            ? { charCount: 200 }
            : { durationSeconds: 30 };

  await usageRecordsRepo.insertUsageRecord(pg.db, {
    customerId: input.customerId,
    workId: input.workId,
    createdAt: input.createdAt,
    kind,
    model: input.model ?? 'gpt-4o-mini',
    nodeUrl: 'http://node-1.test',
    promptTokensLocal: input.promptLocal ?? null,
    completionTokensLocal: input.completionLocal ?? null,
    ...tokenCols,
    costUsdCents: input.costCents,
    nodeCostWei: '0',
    status: input.status ?? 'success',
  });
}

describe('usageRollups.rollup', () => {
  it('groups by day and sums tokens / requests / cost', async () => {
    const cid = await seedCustomer();
    const day1 = new Date('2026-04-20T10:00:00Z');
    const day2 = new Date('2026-04-21T10:00:00Z');
    const day3 = new Date('2026-04-22T10:00:00Z');

    await seedRecord({ customerId: cid, workId: 'w1', createdAt: day1, promptLocal: 100, completionLocal: 50, costCents: 5n });
    await seedRecord({ customerId: cid, workId: 'w2', createdAt: day1, promptLocal: 200, completionLocal: 80, costCents: 10n });
    await seedRecord({ customerId: cid, workId: 'w3', createdAt: day2, promptLocal: 50, completionLocal: 25, costCents: 3n });
    await seedRecord({ customerId: cid, workId: 'w4', createdAt: day3, promptLocal: 300, completionLocal: 150, costCents: 20n });

    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-23T00:00:00Z'),
      groupBy: 'day',
    });

    expect(rows).toHaveLength(3);
    // Sorted desc by bucket
    expect(rows[0]).toMatchObject({
      bucket: '2026-04-22',
      promptTokens: 300,
      completionTokens: 150,
      requests: 1,
      costUsdCents: 20n,
    });
    expect(rows[1]).toMatchObject({
      bucket: '2026-04-21',
      promptTokens: 50,
      completionTokens: 25,
      requests: 1,
    });
    expect(rows[2]).toMatchObject({
      bucket: '2026-04-20',
      promptTokens: 300,
      completionTokens: 130,
      requests: 2,
      costUsdCents: 15n,
    });
  });

  it('groups by model', async () => {
    const cid = await seedCustomer();
    const t = new Date('2026-04-20T10:00:00Z');
    await seedRecord({ customerId: cid, workId: 'a', createdAt: t, model: 'gpt-4o', promptLocal: 100, costCents: 10n });
    await seedRecord({ customerId: cid, workId: 'b', createdAt: t, model: 'gpt-4o', promptLocal: 200, costCents: 20n });
    await seedRecord({ customerId: cid, workId: 'c', createdAt: t, model: 'gpt-4o-mini', promptLocal: 50, costCents: 5n });

    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
      groupBy: 'model',
    });

    expect(rows).toHaveLength(2);
    const byModel = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    expect(byModel['gpt-4o']?.promptTokens).toBe(300);
    expect(byModel['gpt-4o']?.requests).toBe(2);
    expect(byModel['gpt-4o-mini']?.promptTokens).toBe(50);
  });

  it('groups by capability (kind)', async () => {
    const cid = await seedCustomer();
    const t = new Date('2026-04-20T10:00:00Z');
    await seedRecord({ customerId: cid, workId: 'c1', createdAt: t, kind: 'chat', costCents: 10n });
    await seedRecord({ customerId: cid, workId: 'c2', createdAt: t, kind: 'chat', costCents: 5n });
    await seedRecord({ customerId: cid, workId: 'e1', createdAt: t, kind: 'embeddings', costCents: 2n });
    await seedRecord({ customerId: cid, workId: 'i1', createdAt: t, kind: 'images', costCents: 30n });

    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
      groupBy: 'capability',
    });

    expect(rows).toHaveLength(3);
    const byKind = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    expect(byKind.chat?.requests).toBe(2);
    expect(byKind.chat?.costUsdCents).toBe(15n);
    expect(byKind.embeddings?.requests).toBe(1);
    expect(byKind.images?.requests).toBe(1);
  });

  it('counts status_breakdown correctly', async () => {
    const cid = await seedCustomer();
    const t = new Date('2026-04-20T10:00:00Z');
    await seedRecord({ customerId: cid, workId: 's1', createdAt: t, costCents: 1n, status: 'success' });
    await seedRecord({ customerId: cid, workId: 's2', createdAt: t, costCents: 1n, status: 'success' });
    await seedRecord({ customerId: cid, workId: 's3', createdAt: t, costCents: 1n, status: 'partial' });
    await seedRecord({ customerId: cid, workId: 's4', createdAt: t, costCents: 1n, status: 'failed' });

    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
      groupBy: 'day',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requests: 4,
      successCount: 2,
      partialCount: 1,
      failedCount: 1,
    });
  });

  it('falls back to *_reported when *_local is null', async () => {
    const cid = await seedCustomer();
    const t = new Date('2026-04-20T10:00:00Z');
    // Local null, reported set — rollup should pick up reported.
    await seedRecord({
      customerId: cid,
      workId: 'fb1',
      createdAt: t,
      promptReported: 500,
      completionReported: 200,
      costCents: 1n,
    });

    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
      groupBy: 'day',
    });
    expect(rows[0]?.promptTokens).toBe(500);
    expect(rows[0]?.completionTokens).toBe(200);
  });

  it('respects [from, to) window boundaries', async () => {
    const cid = await seedCustomer();
    await seedRecord({ customerId: cid, workId: 'in', createdAt: new Date('2026-04-20T12:00:00Z'), costCents: 1n });
    await seedRecord({ customerId: cid, workId: 'before', createdAt: new Date('2026-04-19T23:59:59Z'), costCents: 1n });
    await seedRecord({ customerId: cid, workId: 'at-to', createdAt: new Date('2026-04-21T00:00:00Z'), costCents: 1n });

    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-20T00:00:00Z'),
      to: new Date('2026-04-21T00:00:00Z'),
      groupBy: 'day',
    });
    // Only 'in' should match — 'before' is below from, 'at-to' is exactly to (excluded).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requests).toBe(1);
  });

  it('isolates per customer', async () => {
    const a = await seedCustomer('a@x.io');
    const b = await seedCustomer('b@x.io');
    const t = new Date('2026-04-20T10:00:00Z');
    await seedRecord({ customerId: a, workId: 'a-1', createdAt: t, promptLocal: 100, costCents: 5n });
    await seedRecord({ customerId: b, workId: 'b-1', createdAt: t, promptLocal: 999, costCents: 50n });

    const rowsA = await rollup(pg.db, {
      customerId: a,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
      groupBy: 'day',
    });
    expect(rowsA[0]?.promptTokens).toBe(100);
    expect(rowsA[0]?.costUsdCents).toBe(5n);
  });

  it('returns empty array when no records match', async () => {
    const cid = await seedCustomer();
    const rows = await rollup(pg.db, {
      customerId: cid,
      from: new Date('2026-04-19T00:00:00Z'),
      to: new Date('2026-04-22T00:00:00Z'),
      groupBy: 'day',
    });
    expect(rows).toEqual([]);
  });
});
