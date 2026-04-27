import { z } from 'zod';
import { CustomerTierSchema } from '@cloudspe/livepeer-gateway-core/types/tier.js';

export { CustomerTierSchema, type CustomerTier } from '@cloudspe/livepeer-gateway-core/types/tier.js';

export const CustomerIdSchema = z.string().uuid().brand<'CustomerId'>();
export type CustomerId = z.infer<typeof CustomerIdSchema>;

export const CustomerStatusSchema = z.enum(['active', 'suspended', 'closed']);
export type CustomerStatus = z.infer<typeof CustomerStatusSchema>;

export const ApiKeyIdSchema = z.string().uuid().brand<'ApiKeyId'>();
export type ApiKeyId = z.infer<typeof ApiKeyIdSchema>;

export const ApiKeySchema = z.object({
  id: ApiKeyIdSchema,
  customerId: CustomerIdSchema,
  hash: z.string().min(1),
  label: z.string().max(64).nullable(),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const BalanceEntrySchema = z.object({
  customerId: CustomerIdSchema,
  balanceUsdCents: z.bigint().nonnegative(),
  reservedUsdCents: z.bigint().nonnegative(),
  updatedAt: z.coerce.date(),
});
export type BalanceEntry = z.infer<typeof BalanceEntrySchema>;

export const QuotaEntrySchema = z.object({
  customerId: CustomerIdSchema,
  monthlyAllowanceTokens: z.bigint().positive(),
  remainingTokens: z.bigint().nonnegative(),
  resetAt: z.coerce.date(),
});
export type QuotaEntry = z.infer<typeof QuotaEntrySchema>;

export const CustomerSchema = z.object({
  id: CustomerIdSchema,
  email: z.string().email(),
  tier: CustomerTierSchema,
  status: CustomerStatusSchema,
  rateLimitTier: z.string().min(1),
  createdAt: z.coerce.date(),
});
export type Customer = z.infer<typeof CustomerSchema>;
