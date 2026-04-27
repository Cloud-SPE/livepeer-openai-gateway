import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from './testPg.js';
import * as customersRepo from '../../repo/customers.js';
import {
  BalanceInsufficientError,
  commit,
  commitQuota,
  creditTopup,
  QuotaExceededError,
  refund,
  refundQuota,
  reserve,
  reserveQuota,
  TierMismatchError,
} from './index.js';

let pg: TestPg;

beforeAll(async () => {
  pg = await startTestPg();
});

afterAll(async () => {
  if (pg) await pg.close();
});

beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.customers CASCADE`,
  );
});

async function seedPrepaidCustomer(balanceCents: bigint): Promise<string> {
  const row = await customersRepo.insertCustomer(pg.db, {
    email: `cust-${Math.random().toString(36).slice(2)}@example.com`,
    tier: 'prepaid',
    balanceUsdCents: balanceCents,
  });
  return row.id;
}

async function seedFreeCustomer(quotaTokens: bigint): Promise<string> {
  const row = await customersRepo.insertCustomer(pg.db, {
    email: `cust-${Math.random().toString(36).slice(2)}@example.com`,
    tier: 'free',
    quotaTokensRemaining: quotaTokens,
    quotaMonthlyAllowance: quotaTokens,
  });
  return row.id;
}

describe('prepaid reserve / commit / refund', () => {
  it('reserves, commits less than reserved, and refunds the delta', async () => {
    const id = await seedPrepaidCustomer(1000n);

    const res = await reserve(pg.db, {
      customerId: id,
      workId: 'w-1',
      estCostCents: 400n,
    });
    expect(res.amountUsdCents).toBe(400n);

    const afterReserve = await customersRepo.findById(pg.db, id);
    expect(afterReserve?.balanceUsdCents).toBe(1000n);
    expect(afterReserve?.reservedUsdCents).toBe(400n);

    const committed = await commit(pg.db, {
      reservationId: res.reservationId,
      actualCostCents: 250n,
    });
    expect(committed.actualUsdCents).toBe(250n);
    expect(committed.refundedUsdCents).toBe(150n);

    const afterCommit = await customersRepo.findById(pg.db, id);
    expect(afterCommit?.balanceUsdCents).toBe(750n);
    expect(afterCommit?.reservedUsdCents).toBe(0n);
  });

  it('caps actual at reserved amount', async () => {
    const id = await seedPrepaidCustomer(1000n);
    const res = await reserve(pg.db, { customerId: id, workId: 'w-2', estCostCents: 100n });
    const committed = await commit(pg.db, {
      reservationId: res.reservationId,
      actualCostCents: 500n,
    });
    expect(committed.actualUsdCents).toBe(100n);
    expect(committed.refundedUsdCents).toBe(0n);
  });

  it('refund returns reserved to available without changing balance', async () => {
    const id = await seedPrepaidCustomer(500n);
    const res = await reserve(pg.db, { customerId: id, workId: 'w-3', estCostCents: 300n });
    const refunded = await refund(pg.db, res.reservationId);
    expect(refunded.refundedUsdCents).toBe(300n);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.balanceUsdCents).toBe(500n);
    expect(after?.reservedUsdCents).toBe(0n);
  });

  it('rejects reserve when balance is insufficient', async () => {
    const id = await seedPrepaidCustomer(50n);
    await expect(
      reserve(pg.db, { customerId: id, workId: 'w-4', estCostCents: 100n }),
    ).rejects.toBeInstanceOf(BalanceInsufficientError);
  });

  it('rejects prepaid ops on a free-tier customer', async () => {
    const id = await seedFreeCustomer(1000n);
    await expect(
      reserve(pg.db, { customerId: id, workId: 'w-5', estCostCents: 10n }),
    ).rejects.toBeInstanceOf(TierMismatchError);
  });
});

describe('free-tier quota reserve / commit / refund', () => {
  it('reserves, commits, and adjusts remaining + reserved', async () => {
    const id = await seedFreeCustomer(1000n);
    const res = await reserveQuota(pg.db, { customerId: id, workId: 'fw-1', estTokens: 400n });
    expect(res.amountTokens).toBe(400n);

    const committed = await commitQuota(pg.db, {
      reservationId: res.reservationId,
      actualTokens: 250n,
    });
    expect(committed.actualTokens).toBe(250n);
    expect(committed.refundedTokens).toBe(150n);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.quotaTokensRemaining).toBe(750n);
    expect(after?.quotaReservedTokens).toBe(0n);
  });

  it('refunds quota without touching remaining', async () => {
    const id = await seedFreeCustomer(500n);
    const res = await reserveQuota(pg.db, { customerId: id, workId: 'fw-2', estTokens: 200n });
    const refunded = await refundQuota(pg.db, res.reservationId);
    expect(refunded.refundedTokens).toBe(200n);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.quotaTokensRemaining).toBe(500n);
    expect(after?.quotaReservedTokens).toBe(0n);
  });

  it('rejects quota reserve when tokens are insufficient', async () => {
    const id = await seedFreeCustomer(100n);
    await expect(
      reserveQuota(pg.db, { customerId: id, workId: 'fw-3', estTokens: 500n }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('creditTopup', () => {
  it('inserts a topup row and credits balance atomically', async () => {
    const id = await seedPrepaidCustomer(100n);
    const result = await creditTopup(pg.db, {
      customerId: id,
      stripeSessionId: 'cs_test_1',
      amountUsdCents: 2500n,
    });
    expect(result.newBalanceUsdCents).toBe(2600n);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.balanceUsdCents).toBe(2600n);
  });
});

describe('concurrent reserve correctness (FOR UPDATE serializes per customer)', () => {
  it('exactly N successful reserves fit within balance; no double-spend', async () => {
    // balance = 100 cents; each reserve = 10 cents; fire 20 in parallel.
    // Expect exactly 10 successes and 10 BalanceInsufficient errors.
    const id = await seedPrepaidCustomer(100n);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reserve(pg.db, {
          customerId: id,
          workId: `concurrent-${i}`,
          estCostCents: 10n,
        }),
      ),
    );

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof BalanceInsufficientError,
    ).length;

    expect(successes).toBe(10);
    expect(failures).toBe(10);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.reservedUsdCents).toBe(100n);
    expect(after?.balanceUsdCents).toBe(100n);
    // Invariant: no overcommit. available = balance - reserved must be ≥ 0.
    expect((after?.balanceUsdCents ?? 0n) - (after?.reservedUsdCents ?? 0n)).toBe(0n);
  });

  it('different customers reserve in parallel without serializing against each other', async () => {
    const a = await seedPrepaidCustomer(1000n);
    const b = await seedPrepaidCustomer(1000n);

    const results = await Promise.all([
      reserve(pg.db, { customerId: a, workId: 'par-a', estCostCents: 500n }),
      reserve(pg.db, { customerId: b, workId: 'par-b', estCostCents: 500n }),
    ]);
    expect(results).toHaveLength(2);

    const [rowA, rowB] = await Promise.all([
      customersRepo.findById(pg.db, a),
      customersRepo.findById(pg.db, b),
    ]);
    expect(rowA?.reservedUsdCents).toBe(500n);
    expect(rowB?.reservedUsdCents).toBe(500n);
  });
});
