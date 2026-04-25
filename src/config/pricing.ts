import { z } from 'zod';
import type {
  ChatRateCard,
  ChatRateCardEntry,
  EmbeddingsRateCard,
  EmbeddingsRateCardEntry,
  ImageQuality,
  ImageSize,
  ImagesRateCard,
  ImagesRateCardEntry,
  PricingTier,
} from '../types/pricing.js';

export interface PricingConfig {
  rateCard: ChatRateCard;
  embeddingsRateCard: EmbeddingsRateCard;
  imagesRateCard: ImagesRateCard;
  modelToTier: Map<string, PricingTier>;
  defaultMaxTokensPrepaid: number;
  defaultMaxTokensFree: number;
}

const V1_RATE_CARD: ChatRateCard = {
  version: 'v1-2026-04-24',
  effectiveAt: new Date('2026-04-24T00:00:00Z'),
  entries: [
    { tier: 'starter', inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.6 },
    { tier: 'standard', inputUsdPerMillion: 1.0, outputUsdPerMillion: 3.0 },
    { tier: 'pro', inputUsdPerMillion: 3.0, outputUsdPerMillion: 10.0 },
  ],
};

const V1_EMBEDDINGS_RATE_CARD: EmbeddingsRateCard = {
  version: 'v1-2026-04-24',
  effectiveAt: new Date('2026-04-24T00:00:00Z'),
  entries: [
    { model: 'text-embedding-3-small', usdPerMillionTokens: 0.025 },
    { model: 'text-embedding-3-large', usdPerMillionTokens: 0.15 },
    { model: 'text-embedding-bge-m3', usdPerMillionTokens: 0.02 },
  ],
};

const V1_IMAGES_RATE_CARD: ImagesRateCard = {
  version: 'v1-2026-04-24',
  effectiveAt: new Date('2026-04-24T00:00:00Z'),
  entries: [
    { model: 'dall-e-3', size: '1024x1024', quality: 'standard', usdPerImage: 0.05 },
    { model: 'dall-e-3', size: '1024x1024', quality: 'hd', usdPerImage: 0.09 },
    { model: 'dall-e-3', size: '1024x1792', quality: 'standard', usdPerImage: 0.09 },
    { model: 'dall-e-3', size: '1024x1792', quality: 'hd', usdPerImage: 0.13 },
    { model: 'dall-e-3', size: '1792x1024', quality: 'standard', usdPerImage: 0.09 },
    { model: 'dall-e-3', size: '1792x1024', quality: 'hd', usdPerImage: 0.13 },
    { model: 'sdxl', size: '1024x1024', quality: 'standard', usdPerImage: 0.01 },
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
    embeddingsRateCard: V1_EMBEDDINGS_RATE_CARD,
    imagesRateCard: V1_IMAGES_RATE_CARD,
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

export function rateForTier(rateCard: ChatRateCard, tier: PricingTier): ChatRateCardEntry {
  const entry = rateCard.entries.find((e) => e.tier === tier);
  if (!entry) throw new Error(`no rate card entry for tier=${tier}`);
  return entry;
}

export function rateForEmbeddingsModel(
  rateCard: EmbeddingsRateCard,
  model: string,
): EmbeddingsRateCardEntry {
  const entry = rateCard.entries.find((e) => e.model === model);
  if (!entry) throw new Error(`no embeddings rate card entry for model=${model}`);
  return entry;
}

export function rateForImageSku(
  rateCard: ImagesRateCard,
  model: string,
  size: ImageSize,
  quality: ImageQuality,
): ImagesRateCardEntry {
  const entry = rateCard.entries.find(
    (e) => e.model === model && e.size === size && e.quality === quality,
  );
  if (!entry) {
    throw new Error(
      `no images rate card entry for model=${model} size=${size} quality=${quality}`,
    );
  }
  return entry;
}
