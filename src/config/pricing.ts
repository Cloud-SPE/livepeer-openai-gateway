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

// ─── v2 rate cards (2026-04-25 rebalance) ───────────────────────────────
//
// Positioning: Livepeer is the cheapest mainstream OpenAI-compatible
// endpoint at every tier, in every category. Margin comes from worker-
// side pricing being ~10× cheaper than the bridge customer rate; this
// preserves a healthy spread for infra costs + redemption gas + bridge
// operations while still undercutting all major providers.
//
// Competitive references at 2026-04 (per 1M tokens, input/output unless
// noted):
//   chat:
//     - OpenAI gpt-4o-mini      $0.15 / $0.60
//     - OpenAI gpt-3.5-turbo    $0.50 / $1.50
//     - Anthropic Claude Haiku  $0.25 / $1.25
//     - Together llama-3.1-70b  $0.88 / $0.88
//     - Replicate llama-3.1-70b ~$0.65 / $2.75
//   embeddings (per 1M tokens):
//     - OpenAI text-embedding-3-small  $0.020
//     - OpenAI text-embedding-3-large  $0.130
//     - Together / Voyage              $0.008–0.10
//   images (per 1024x1024):
//     - OpenAI dall-e-3 standard       $0.040
//     - OpenAI dall-e-3 hd             $0.080
//     - Replicate / Together SDXL      ~$0.003
//   speech (per 1M chars):
//     - OpenAI tts-1                   $15
//     - OpenAI tts-1-hd                $30
//     - ElevenLabs                     $30+
//   transcriptions (per minute):
//     - OpenAI whisper-1               $0.006
//     - Deepgram                       $0.0043
//     - AssemblyAI                     $0.0065

const V1_RATE_CARD: ChatRateCard = {
  version: 'v2-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  // Tier targets:
  //   starter  — heavily-batched commodity workers; strictly undercuts
  //              OpenAI gpt-4o-mini ($0.15/$0.60).
  //   standard — moderately-batched; strictly undercuts Anthropic
  //              Claude Haiku ($0.25/$1.25).
  //   pro      — light batching on prosumer GPUs; cheaper than Together
  //              llama-70b ($0.88/$0.88) and Replicate ($0.65/$2.75).
  //   premium  — single-user serving / niche / fine-tuned models on
  //              retail GPUs. Positioned BELOW OpenAI gpt-4o
  //              ($2.50/$10) and Claude Sonnet 3.5 ($3/$15) — premium
  //              over commodity, but still cheaper than the frontier
  //              commercial endpoints. See pricing-model.md
  //              "Worker operator economics" for the throughput-vs-
  //              break-even math that motivates this tier.
  entries: [
    { tier: 'starter', inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.1 },
    { tier: 'standard', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.4 },
    { tier: 'pro', inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.2 },
    { tier: 'premium', inputUsdPerMillion: 2.5, outputUsdPerMillion: 6.0 },
  ],
};

const V1_EMBEDDINGS_RATE_CARD: EmbeddingsRateCard = {
  version: 'v2-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  entries: [
    // Strictly undercuts OpenAI's $0.02 small / $0.13 large.
    { model: 'text-embedding-3-small', usdPerMillionTokens: 0.005 },
    { model: 'text-embedding-3-large', usdPerMillionTokens: 0.05 },
    // Open-source bge-m3 — cheapest in the class.
    { model: 'text-embedding-bge-m3', usdPerMillionTokens: 0.005 },
  ],
};

const V1_IMAGES_RATE_CARD: ImagesRateCard = {
  version: 'v2-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  entries: [
    // dall-e-3 — strictly cheaper than OpenAI's $0.040 / $0.080 list.
    { model: 'dall-e-3', size: '1024x1024', quality: 'standard', usdPerImage: 0.025 },
    { model: 'dall-e-3', size: '1024x1024', quality: 'hd', usdPerImage: 0.05 },
    { model: 'dall-e-3', size: '1024x1792', quality: 'standard', usdPerImage: 0.04 },
    { model: 'dall-e-3', size: '1024x1792', quality: 'hd', usdPerImage: 0.075 },
    { model: 'dall-e-3', size: '1792x1024', quality: 'standard', usdPerImage: 0.04 },
    { model: 'dall-e-3', size: '1792x1024', quality: 'hd', usdPerImage: 0.075 },
    // sdxl — cheaper than Replicate / Together's ~$0.003.
    { model: 'sdxl', size: '1024x1024', quality: 'standard', usdPerImage: 0.002 },
  ],
};

const V1_SPEECH_RATE_CARD: SpeechRateCard = {
  version: 'v2-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  // Strictly undercuts OpenAI's $15 / $30. Kokoro on open-source backend
  // priced as the volume play.
  entries: [
    { model: 'tts-1', usdPerMillionChars: 5.0 },
    { model: 'tts-1-hd', usdPerMillionChars: 12.0 },
    { model: 'kokoro', usdPerMillionChars: 1.0 },
  ],
};

const V1_TRANSCRIPTIONS_RATE_CARD: TranscriptionsRateCard = {
  version: 'v2-2026-04-25',
  effectiveAt: new Date('2026-04-25T00:00:00Z'),
  // Strictly undercuts OpenAI whisper-1 ($0.006/min), Deepgram ($0.0043),
  // AssemblyAI ($0.0065).
  entries: [{ model: 'whisper-1', usdPerMinute: 0.003 }],
};

const V1_MODEL_TO_TIER: Array<[string, PricingTier]> = [
  ['model-small', 'starter'],
  ['model-medium', 'standard'],
  ['model-large', 'pro'],
  // `model-premium` is a placeholder for tests + the new premium tier
  // (single-user / niche / fine-tune workloads). Real premium models —
  // operator-specific fine-tunes or specialty serving — should be
  // added by the operator when they bring a worker online.
  ['model-premium', 'premium'],
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
