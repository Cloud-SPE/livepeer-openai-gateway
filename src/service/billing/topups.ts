import type { Db } from '../../repo/db.js';
import * as customersRepo from '../../repo/customers.js';
import * as topupsRepo from '../../repo/topups.js';
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
    await customersRepo.updateBalanceFields(tx, input.customerId, {
      balanceUsdCents: newBalance,
    });

    return {
      customerId: input.customerId,
      stripeSessionId: input.stripeSessionId,
      creditedUsdCents: input.amountUsdCents,
      newBalanceUsdCents: newBalance,
    };
  });
}
