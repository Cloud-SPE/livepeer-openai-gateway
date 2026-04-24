import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from './testPg.js';
import * as customersRepo from '../../repo/customers.js';
import {
  BalanceInsufficientError,
  commit,
  commitQuota,
  creditTopup,
  CustomerNotFoundError,
  QuotaExceededError,
  refund,
  refundQuota,
  reserve,
  reserveQuota,
  ReservationNotOpenError,
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
  await pg.db.execute(sql`TRUNCATE TABLE reservation, usage_record, topup, customer CASCADE`);
});

const ghostId = '00000000-0000-4000-8000-000000000000';

describe('billing error paths', () => {
  it('reserve/reserveQuota throw CustomerNotFoundError for a missing customer', async () => {
    await expect(
      reserve(pg.db, { customerId: ghostId, workId: 'g-1', estCostCents: 1n }),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);

    await expect(
      reserveQuota(pg.db, { customerId: ghostId, workId: 'g-2', estTokens: 1n }),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
  });

  it('commit/refund throw ReservationNotOpenError on unknown or non-open reservations', async () => {
    await expect(
      commit(pg.db, { reservationId: ghostId, actualCostCents: 1n }),
    ).rejects.toBeInstanceOf(ReservationNotOpenError);

    await expect(refund(pg.db, ghostId)).rejects.toBeInstanceOf(ReservationNotOpenError);
    await expect(
      commitQuota(pg.db, { reservationId: ghostId, actualTokens: 1n }),
    ).rejects.toBeInstanceOf(ReservationNotOpenError);
    await expect(refundQuota(pg.db, ghostId)).rejects.toBeInstanceOf(ReservationNotOpenError);
  });

  it('commit rejects a committed reservation as not-open', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'committed@x.io',
      apiKeyHash: 'c',
      tier: 'prepaid',
      balanceUsdCents: 100n,
    });
    const res = await reserve(pg.db, {
      customerId: customer.id,
      workId: 'once',
      estCostCents: 10n,
    });
    await commit(pg.db, { reservationId: res.reservationId, actualCostCents: 5n });
    await expect(
      commit(pg.db, { reservationId: res.reservationId, actualCostCents: 5n }),
    ).rejects.toBeInstanceOf(ReservationNotOpenError);
  });

  it('commit of a prepaid reservation rejects when the reservation row is free-kind', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'mix@x.io',
      apiKeyHash: 'm',
      tier: 'free',
      quotaTokensRemaining: 100n,
      quotaMonthlyAllowance: 100n,
    });
    const freeRes = await reserveQuota(pg.db, {
      customerId: customer.id,
      workId: 'mix-1',
      estTokens: 10n,
    });
    await expect(
      commit(pg.db, { reservationId: freeRes.reservationId, actualCostCents: 1n }),
    ).rejects.toBeInstanceOf(TierMismatchError);
    await expect(refund(pg.db, freeRes.reservationId)).rejects.toBeInstanceOf(TierMismatchError);
  });

  it('commitQuota / refundQuota reject a prepaid reservation', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'mix2@x.io',
      apiKeyHash: 'm2',
      tier: 'prepaid',
      balanceUsdCents: 100n,
    });
    const res = await reserve(pg.db, {
      customerId: customer.id,
      workId: 'mix-2',
      estCostCents: 10n,
    });
    await expect(
      commitQuota(pg.db, { reservationId: res.reservationId, actualTokens: 1n }),
    ).rejects.toBeInstanceOf(TierMismatchError);
    await expect(refundQuota(pg.db, res.reservationId)).rejects.toBeInstanceOf(TierMismatchError);
  });

  it('reserveQuota rejects a prepaid customer', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'pp@x.io',
      apiKeyHash: 'pp',
      tier: 'prepaid',
      balanceUsdCents: 100n,
    });
    await expect(
      reserveQuota(pg.db, { customerId: customer.id, workId: 'pp-1', estTokens: 10n }),
    ).rejects.toBeInstanceOf(TierMismatchError);
  });

  it('error subclasses expose their fields', () => {
    const balErr = new BalanceInsufficientError(10n, 20n);
    expect(balErr.availableCents).toBe(10n);
    expect(balErr.requestedCents).toBe(20n);

    const quotaErr = new QuotaExceededError(5n, 9n);
    expect(quotaErr.availableTokens).toBe(5n);
    expect(quotaErr.requestedTokens).toBe(9n);

    const tierErr = new TierMismatchError('cust', 'free', 'prepaid');
    expect(tierErr.expected).toBe('free');
    expect(tierErr.actual).toBe('prepaid');
  });

  it('creditTopup throws CustomerNotFoundError for a missing customer', async () => {
    await expect(
      creditTopup(pg.db, {
        customerId: ghostId,
        stripeSessionId: 'cs_ghost',
        amountUsdCents: 100n,
      }),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
  });
});
