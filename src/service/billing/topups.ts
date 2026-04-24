import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import * as customersRepo from '../../repo/customers.js';
import * as topupsRepo from '../../repo/topups.js';
import { topups, customers } from '../../repo/schema.js';
import { CustomerNotFoundError } from './errors.js';

export interface CreditTopupInput {
  customerId: string;
  stripeSessionId: string;
  amountUsdCents: bigint;
}

export interface CreditTopupResult {
  customerId: string;
  stripeSessionId: string;
  creditedUsdCents: bigint;
  newBalanceUsdCents: bigint;
  upgradedFromFree: boolean;
}

export async function creditTopup(db: Db, input: CreditTopupInput): Promise<CreditTopupResult> {
  return db.transaction(async (tx) => {
    const customer = await customersRepo.selectForUpdate(tx, input.customerId);
    if (!customer) throw new CustomerNotFoundError(input.customerId);

    await topupsRepo.insertTopup(tx, {
      customerId: input.customerId,
      stripeSessionId: input.stripeSessionId,
      amountUsdCents: input.amountUsdCents,
      status: 'succeeded',
    });

    const newBalance = customer.balanceUsdCents + input.amountUsdCents;
    const upgradedFromFree = customer.tier === 'free';

    await tx
      .update(customers)
      .set({
        balanceUsdCents: newBalance,
        ...(upgradedFromFree ? { tier: 'prepaid' as const, rateLimitTier: 'prepaid-default' } : {}),
      })
      .where(eq(customers.id, input.customerId));

    return {
      customerId: input.customerId,
      stripeSessionId: input.stripeSessionId,
      creditedUsdCents: input.amountUsdCents,
      newBalanceUsdCents: newBalance,
      upgradedFromFree,
    };
  });
}

export async function markTopupDisputed(
  db: Db,
  stripeSessionId: string,
  disputedAt: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .update(topups)
    .set({ disputedAt })
    .where(eq(topups.stripeSessionId, stripeSessionId))
    .returning({ id: topups.id });
  return result.length > 0;
}

export async function findTopupBySession(
  db: Db,
  stripeSessionId: string,
): Promise<typeof topups.$inferSelect | null> {
  const rows = await db
    .select()
    .from(topups)
    .where(sql`${topups.stripeSessionId} = ${stripeSessionId}`)
    .limit(1);
  return rows[0] ?? null;
}
