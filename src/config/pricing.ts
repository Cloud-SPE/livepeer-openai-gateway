import { z } from 'zod';
import type { PricingTier, RateCard, RateCardEntry } from '../types/pricing.js';

export interface PricingConfig {
  rateCard: RateCard;
  modelToTier: Map<string, PricingTier>;
  defaultMaxTokensPrepaid: number;
  defaultMaxTokensFree: number;
}

const V1_RATE_CARD: RateCard = {
  version: 'v1-2026-04-24',
  effectiveAt: new Date('2026-04-24T00:00:00Z'),
  entries: [
    { tier: 'starter', inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.6 },
    { tier: 'standard', inputUsdPerMillion: 1.0, outputUsdPerMillion: 3.0 },
    { tier: 'pro', inputUsdPerMillion: 3.0, outputUsdPerMillion: 10.0 },
  ],
};

const V1_MODEL_TO_TIER: Array<[string, PricingTier]> = [
  ['model-small', 'starter'],
  ['model-medium', 'standard'],
  ['model-large', 'pro'],
];

export function defaultPricingConfig(): PricingConfig {
  return {
    rateCard: V1_RATE_CARD,
    modelToTier: new Map(V1_MODEL_TO_TIER),
    defaultMaxTokensPrepaid: 4096,
    defaultMaxTokensFree: 1024,
  };
}

const OverrideSchema = z.object({
  PRICING_DEFAULT_MAX_TOKENS_PREPAID: z.coerce.number().int().positive().optional(),
  PRICING_DEFAULT_MAX_TOKENS_FREE: z.coerce.number().int().positive().optional(),
});

export function loadPricingConfig(env: NodeJS.ProcessEnv = process.env): PricingConfig {
  const parsed = OverrideSchema.parse(env);
  const base = defaultPricingConfig();
  return {
    ...base,
    defaultMaxTokensPrepaid:
      parsed.PRICING_DEFAULT_MAX_TOKENS_PREPAID ?? base.defaultMaxTokensPrepaid,
    defaultMaxTokensFree: parsed.PRICING_DEFAULT_MAX_TOKENS_FREE ?? base.defaultMaxTokensFree,
  };
}

export function rateForTier(rateCard: RateCard, tier: PricingTier): RateCardEntry {
  const entry = rateCard.entries.find((e) => e.tier === tier);
  if (!entry) throw new Error(`no rate card entry for tier=${tier}`);
  return entry;
}
