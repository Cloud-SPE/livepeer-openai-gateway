import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import * as customersRepo from '../../repo/customers.js';
import { topups } from '../../repo/schema.js';
import { usageRecords } from '@cloud-spe/bridge-core/repo/schema.js';
import { reverseTopup, setCustomerStatus } from '../billing/topups.js';
import type { ReverseTopupResult } from '../billing/topups.js';

/**
 * Shell half of the admin service. Owns customer-facing operations:
 * customer detail (with topups/usage), refund (reverse topup), suspend,
 * unsuspend. Stage 3 keeps this in the proprietary shell package.
 *
 * Per exec-plan 0025.
 */
export interface CustomerDetail {
  id: string;
  email: string;
  tier: 'free' | 'prepaid';
  status: 'active' | 'suspended' | 'closed';
  balanceUsdCents: string;
  reservedUsdCents: string;
  quotaTokensRemaining: string | null;
  quotaMonthlyAllowance: string | null;
  rateLimitTier: string;
  createdAt: Date;
  topups: Array<{
    stripeSessionId: string;
    amountUsdCents: string;
    status: string;
    createdAt: Date;
    refundedAt: Date | null;
    disputedAt: Date | null;
  }>;
  recentUsage: Array<{
    workId: string;
    model: string;
    costUsdCents: string;
    status: string;
    createdAt: Date;
  }>;
}

export interface ShellAdminServiceDeps {
  db: Db;
}

export interface ShellAdminService {
  getCustomer(id: string): Promise<CustomerDetail | null>;
  reverseCustomerTopup(input: {
    stripeSessionId: string;
    reason: string;
  }): Promise<ReverseTopupResult>;
  suspendCustomer(id: string): Promise<boolean>;
  unsuspendCustomer(id: string): Promise<boolean>;
}

export function createShellAdminService(deps: ShellAdminServiceDeps): ShellAdminService {
  return {
    async getCustomer(id: string): Promise<CustomerDetail | null> {
      const customer = await customersRepo.findById(deps.db, id);
      if (!customer) return null;

      const customerTopups = await deps.db
        .select()
        .from(topups)
        .where(eq(topups.customerId, id))
        .orderBy(desc(topups.createdAt))
        .limit(20);

      const usage = await deps.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.callerId, id))
        .orderBy(desc(usageRecords.createdAt))
        .limit(50);

      return {
        id: customer.id,
        email: customer.email,
        tier: customer.tier,
        status: customer.status,
        balanceUsdCents: customer.balanceUsdCents.toString(),
        reservedUsdCents: customer.reservedUsdCents.toString(),
        quotaTokensRemaining: customer.quotaTokensRemaining?.toString() ?? null,
        quotaMonthlyAllowance: customer.quotaMonthlyAllowance?.toString() ?? null,
        rateLimitTier: customer.rateLimitTier,
        createdAt: customer.createdAt,
        topups: customerTopups.map((t) => ({
          stripeSessionId: t.stripeSessionId,
          amountUsdCents: t.amountUsdCents.toString(),
          status: t.status,
          createdAt: t.createdAt,
          refundedAt: t.refundedAt,
          disputedAt: t.disputedAt,
        })),
        recentUsage: usage.map((u) => ({
          workId: u.workId,
          model: u.model,
          costUsdCents: u.costUsdCents.toString(),
          status: u.status,
          createdAt: u.createdAt,
        })),
      };
    },

    async reverseCustomerTopup(input): Promise<ReverseTopupResult> {
      return reverseTopup(deps.db, input);
    },

    async suspendCustomer(id) {
      return setCustomerStatus(deps.db, id, 'suspended');
    },

    async unsuspendCustomer(id) {
      return setCustomerStatus(deps.db, id, 'active');
    },
  };
}
