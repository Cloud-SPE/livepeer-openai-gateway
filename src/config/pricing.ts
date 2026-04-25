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
  SpeechRateCard,
  SpeechRateCardEntry,
  TranscriptionsRateCard,
  TranscriptionsRateCardEntry,
} from '../types/pricing.js';

export interface PricingConfig {
  rateCard: ChatRateCard;
  embeddingsRateCard: EmbeddingsRateCard;
  imagesRateCard: ImagesRateCard;
  speechRateCard: SpeechRateCard;
  transcriptionsRateCard: TranscriptionsRateCard;
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

const V1_SPEECH_RATE_CARD: SpeechRateCard = {
  version: 'v1-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  // 20% premium over OpenAI list as of 2026-04 (matches the embeddings/images
  // pattern from 0017). tts-1: $15/1M chars → $18; tts-1-hd: $30/1M → $36.
  // Open-source backend (Kokoro / XTTS) priced at a smaller premium against
  // OpenAI's lowest tier so it stays competitive.
  entries: [
    { model: 'tts-1', usdPerMillionChars: 18.0 },
    { model: 'tts-1-hd', usdPerMillionChars: 36.0 },
    { model: 'kokoro', usdPerMillionChars: 6.0 },
  ],
};

const V1_TRANSCRIPTIONS_RATE_CARD: TranscriptionsRateCard = {
  version: 'v1-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  // OpenAI whisper-1 list is $0.006/min as of 2026-04. 20% premium ⇒ $0.0072.
  entries: [{ model: 'whisper-1', usdPerMinute: 0.0072 }],
};

const V1_MODEL_TO_TIER: Array<[string, PricingTier]> = [
  ['model-small', 'starter'],
  ['model-medium', 'standard'],
  ['model-large', 'pro'],
  // Real model names. Add new entries as workers come online with new
  // models; making this env-driven is tracked as `model-tier-env-config`
  // in the tech-debt tracker.
  ['gemma4:26b', 'starter'],
];

export function defaultPricingConfig(): PricingConfig {
  return {
    rateCard: V1_RATE_CARD,
    embeddingsRateCard: V1_EMBEDDINGS_RATE_CARD,
    imagesRateCard: V1_IMAGES_RATE_CARD,
    speechRateCard: V1_SPEECH_RATE_CARD,
    transcriptionsRateCard: V1_TRANSCRIPTIONS_RATE_CARD,
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

export function rateForSpeechModel(
  rateCard: SpeechRateCard,
  model: string,
): SpeechRateCardEntry {
  const entry = rateCard.entries.find((e) => e.model === model);
  if (!entry) throw new Error(`no speech rate card entry for model=${model}`);
  return entry;
}

export function rateForTranscriptionsModel(
  rateCard: TranscriptionsRateCard,
  model: string,
): TranscriptionsRateCardEntry {
  const entry = rateCard.entries.find((e) => e.model === model);
  if (!entry) throw new Error(`no transcriptions rate card entry for model=${model}`);
  return entry;
}
