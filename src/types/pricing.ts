import { z } from 'zod';

export const PricingTierSchema = z.enum(['starter', 'standard', 'pro']);
export type PricingTier = z.infer<typeof PricingTierSchema>;

export const UsdPerMillionTokensSchema = z.number().positive();
export type UsdPerMillionTokens = z.infer<typeof UsdPerMillionTokensSchema>;

export const RateCardEntrySchema = z.object({
  tier: PricingTierSchema,
  inputUsdPerMillion: UsdPerMillionTokensSchema,
  outputUsdPerMillion: UsdPerMillionTokensSchema,
});
export type RateCardEntry = z.infer<typeof RateCardEntrySchema>;

export const RateCardSchema = z.object({
  version: z.string().min(1),
  effectiveAt: z.coerce.date(),
  entries: z.array(RateCardEntrySchema).length(3),
});
export type RateCard = z.infer<typeof RateCardSchema>;

export const ModelIdSchema = z.string().min(1).max(256);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const ModelTierMapSchema = z.record(ModelIdSchema, PricingTierSchema);
export type ModelTierMap = z.infer<typeof ModelTierMapSchema>;
