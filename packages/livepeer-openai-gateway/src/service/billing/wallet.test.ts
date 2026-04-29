import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from './testPg.js';
import * as customersRepo from '../../repo/customers.js';
import type {
  CostQuote,
  UsageReport,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import { UnknownCallerTierError } from '@cloudspe/livepeer-openai-gateway-core/service/billing/errors.js';
import { createPrepaidQuotaWallet } from './wallet.js';

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

function quote(overrides: Partial<CostQuote>): CostQuote {
  return {
    workId: 'wq-1',
    cents: 0n,
    wei: 0n,
    estimatedTokens: 0,
    model: 'm',
    capability: 'chat',
    callerTier: 'prepaid',
    ...overrides,
  };
}

function usage(overrides: Partial<UsageReport>): UsageReport {
  return {
    cents: 0n,
    wei: 0n,
    actualTokens: 0,
    model: 'm',
    capability: 'chat',
    ...overrides,
  };
}

describe('createPrepaidQuotaWallet — prepaid branch', () => {
  it('reserves, commits, and updates customer balance', async () => {
    const id = await seedPrepaidCustomer(1000n);
    const wallet = createPrepaidQuotaWallet({ db: pg.db });

    const handle = await wallet.reserve(
      id,
      quote({ workId: 'w-1', cents: 400n, callerTier: 'prepaid' }),
    );
    expect(handle).not.toBeNull();

    const afterReserve = await customersRepo.findById(pg.db, id);
    expect(afterReserve?.reservedUsdCents).toBe(400n);

    await wallet.commit(handle, usage({ cents: 250n }));

    const afterCommit = await customersRepo.findById(pg.db, id);
    expect(afterCommit?.balanceUsdCents).toBe(750n);
    expect(afterCommit?.reservedUsdCents).toBe(0n);
  });

  it('refunds restore reserved without changing balance', async () => {
    const id = await seedPrepaidCustomer(500n);
    const wallet = createPrepaidQuotaWallet({ db: pg.db });

    const handle = await wallet.reserve(
      id,
      quote({ workId: 'w-2', cents: 300n, callerTier: 'prepaid' }),
    );
    await wallet.refund(handle);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.balanceUsdCents).toBe(500n);
    expect(after?.reservedUsdCents).toBe(0n);
  });
});

describe('createPrepaidQuotaWallet — quota branch', () => {
  it('reserves, commits, and decrements remaining quota', async () => {
    const id = await seedFreeCustomer(10_000n);
    const wallet = createPrepaidQuotaWallet({ db: pg.db });

    const handle = await wallet.reserve(
      id,
      quote({ workId: 'w-3', estimatedTokens: 600, callerTier: 'free' }),
    );
    await wallet.commit(handle, usage({ actualTokens: 400 }));

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.quotaTokensRemaining).toBe(9_600n);
    expect(after?.quotaReservedTokens).toBe(0n);
  });

  it('refunds release reserved tokens without consuming quota', async () => {
    const id = await seedFreeCustomer(5_000n);
    const wallet = createPrepaidQuotaWallet({ db: pg.db });

    const handle = await wallet.reserve(
      id,
      quote({ workId: 'w-4', estimatedTokens: 700, callerTier: 'free' }),
    );
    await wallet.refund(handle);

    const after = await customersRepo.findById(pg.db, id);
    expect(after?.quotaTokensRemaining).toBe(5_000n);
    expect(after?.quotaReservedTokens).toBe(0n);
  });
});

describe('createPrepaidQuotaWallet — tier mismatch', () => {
  it('rejects an unknown tier string', async () => {
    const id = await seedPrepaidCustomer(1000n);
    const wallet = createPrepaidQuotaWallet({ db: pg.db });

    await expect(wallet.reserve(id, quote({ callerTier: 'enterprise' }))).rejects.toBeInstanceOf(
      UnknownCallerTierError,
    );
  });
});
