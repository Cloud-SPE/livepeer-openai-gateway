import type { PricingConfig } from '../../config/pricing.js';
import type { CustomerTier } from '../../types/customer.js';
import type { ChatCompletionRequest, Usage } from '../../types/openai.js';
import type { ImageQuality, ImageSize, PricingTier } from '../../types/pricing.js';
import {
  rateForEmbeddingsModel,
  rateForImageSku,
  rateForSpeechModel,
  rateForTier,
  rateForTranscriptionsModel,
} from '../../config/pricing.js';
import { ModelNotFoundError } from '../routing/errors.js';
import type { TokenAuditService } from '../tokenAudit/index.js';

const MILLION = 1_000_000n;

export function resolveTierForModel(config: PricingConfig, model: string): PricingTier {
  const tier = config.modelToTier.get(model);
  if (!tier) throw new ModelNotFoundError(model);
  return tier;
}

export interface ReservationEstimate {
  estCents: bigint;
  promptEstimateTokens: number;
  maxCompletionTokens: number;
  pricingTier: PricingTier;
}

export function estimateReservation(
  req: ChatCompletionRequest,
  customerTier: CustomerTier,
  config: PricingConfig,
  tokenAudit?: TokenAuditService,
): ReservationEstimate {
  const pricingTier = resolveTierForModel(config, req.model);
  const rate = rateForTier(config.rateCard, pricingTier);

  const auditedPrompt = tokenAudit?.countPromptTokens(req.model, req.messages) ?? null;
  const promptEstimateTokens =
    auditedPrompt !== null
      ? Math.max(1, auditedPrompt)
      : Math.max(1, Math.ceil(req.messages.reduce((sum, m) => sum + m.content.length, 0) / 3));

  const defaultMax =
    customerTier === 'free' ? config.defaultMaxTokensFree : config.defaultMaxTokensPrepaid;
  const maxCompletionTokens = req.max_tokens ?? defaultMax;

  const estCents = computeCostCents(
    BigInt(promptEstimateTokens),
    BigInt(maxCompletionTokens),
    rate.inputUsdPerMillion,
    rate.outputUsdPerMillion,
  );

  return { estCents, promptEstimateTokens, maxCompletionTokens, pricingTier };
}

export interface ActualCost {
  actualCents: bigint;
  pricingTier: PricingTier;
}

export function computeActualCost(
  usage: Usage,
  customerTier: CustomerTier,
  model: string,
  config: PricingConfig,
): ActualCost {
  const pricingTier = resolveTierForModel(config, model);
  void customerTier;
  const rate = rateForTier(config.rateCard, pricingTier);
  const actualCents = computeCostCents(
    BigInt(usage.prompt_tokens),
    BigInt(usage.completion_tokens),
    rate.inputUsdPerMillion,
    rate.outputUsdPerMillion,
  );
  return { actualCents, pricingTier };
}

function computeCostCents(
  promptTokens: bigint,
  outputTokens: bigint,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
): bigint {
  // micro = micro-cents = ¹⁄₁₀_₀₀₀ of a cent. inputCentsPerMillion is
  // already in micro-cents per 1M tokens, so token × rate gives micro
  // directly (no division until the end).
  //
  // Earlier impl divided each side by MILLION before summing, which
  // truncated small amounts to 0 before the ceil could fire — at the
  // v2 cheap rates a 5+3 token request would round to 0 cents instead
  // of 1. Sum the micros first, then divide+ceil exactly once.
  const inputCentsPerMillion = BigInt(Math.round(inputUsdPerMillion * 100 * 10_000));
  const outputCentsPerMillion = BigInt(Math.round(outputUsdPerMillion * 100 * 10_000));

  const microPerMillion = promptTokens * inputCentsPerMillion + outputTokens * outputCentsPerMillion;

  // Round-up division by (MILLION × 10_000) = combined token-and-microcent denom.
  const denom = MILLION * 10_000n;
  return (microPerMillion + denom - 1n) / denom;
}

export interface EmbeddingsReservationEstimate {
  estCents: bigint;
  promptEstimateTokens: number;
}

export function estimateEmbeddingsReservation(
  inputs: string[],
  model: string,
  config: PricingConfig,
): EmbeddingsReservationEstimate {
  const rate = rateForEmbeddingsModel(config.embeddingsRateCard, model);
  const promptEstimateTokens = Math.max(
    1,
    Math.ceil(inputs.reduce((sum, s) => sum + s.length, 0) / 3),
  );
  const estCents = computeInputOnlyCostCents(
    BigInt(promptEstimateTokens),
    rate.usdPerMillionTokens,
  );
  return { estCents, promptEstimateTokens };
}

export function computeEmbeddingsActualCost(
  promptTokens: number,
  model: string,
  config: PricingConfig,
): { actualCents: bigint } {
  const rate = rateForEmbeddingsModel(config.embeddingsRateCard, model);
  const actualCents = computeInputOnlyCostCents(BigInt(promptTokens), rate.usdPerMillionTokens);
  return { actualCents };
}

function computeInputOnlyCostCents(
  promptTokens: bigint,
  inputUsdPerMillion: number,
): bigint {
  const inputCentsPerMillion = BigInt(Math.round(inputUsdPerMillion * 100 * 10_000));
  const inputMicro = (promptTokens * inputCentsPerMillion) / MILLION;
  return (inputMicro + 9999n) / 10_000n;
}

export interface ImagesReservationEstimate {
  estCents: bigint;
  perImageCents: bigint;
  n: number;
}

export function estimateImagesReservation(
  n: number,
  model: string,
  size: ImageSize,
  quality: ImageQuality,
  config: PricingConfig,
): ImagesReservationEstimate {
  const rate = rateForImageSku(config.imagesRateCard, model, size, quality);
  const perImageCents = computePerImageCents(rate.usdPerImage);
  const estCents = perImageCents * BigInt(n);
  return { estCents, perImageCents, n };
}

export function computeImagesActualCost(
  returnedCount: number,
  model: string,
  size: ImageSize,
  quality: ImageQuality,
  config: PricingConfig,
): { actualCents: bigint; perImageCents: bigint } {
  const rate = rateForImageSku(config.imagesRateCard, model, size, quality);
  const perImageCents = computePerImageCents(rate.usdPerImage);
  const actualCents = perImageCents * BigInt(returnedCount);
  return { actualCents, perImageCents };
}

function computePerImageCents(usdPerImage: number): bigint {
  const micro = BigInt(Math.round(usdPerImage * 100 * 10_000));
  return (micro + 9999n) / 10_000n;
}

export interface SpeechReservationEstimate {
  estCents: bigint;
  charCount: number;
}

export function estimateSpeechReservation(
  inputCharCount: number,
  model: string,
  config: PricingConfig,
): SpeechReservationEstimate {
  const rate = rateForSpeechModel(config.speechRateCard, model);
  const charCount = Math.max(0, inputCharCount);
  const estCents = computePerCharCents(BigInt(charCount), rate.usdPerMillionChars);
  return { estCents, charCount };
}

export function computeSpeechActualCost(
  charsBilled: number,
  model: string,
  config: PricingConfig,
): { actualCents: bigint } {
  const rate = rateForSpeechModel(config.speechRateCard, model);
  const actualCents = computePerCharCents(
    BigInt(Math.max(0, charsBilled)),
    rate.usdPerMillionChars,
  );
  return { actualCents };
}

function computePerCharCents(chars: bigint, usdPerMillion: number): bigint {
  const centsPerMillion = BigInt(Math.round(usdPerMillion * 100 * 10_000));
  const micro = (chars * centsPerMillion) / MILLION;
  return (micro + 9999n) / 10_000n;
}

export interface TranscriptionsReservationEstimate {
  estCents: bigint;
  estimatedSeconds: number;
}

// Worst-case estimate: 64 kbps audio (8 KiB/s). This over-estimates
// duration for higher-bitrate uploads, which costs the customer reserve
// (refunded on commit) rather than risking under-charge.
const TRANSCRIPTIONS_BITRATE_BYTES_PER_SEC = 8_000;
const TRANSCRIPTIONS_MAX_RESERVE_SECONDS = 60 * 60;

export function estimateTranscriptionsReservation(
  fileSizeBytes: number,
  model: string,
  config: PricingConfig,
): TranscriptionsReservationEstimate {
  const rate = rateForTranscriptionsModel(config.transcriptionsRateCard, model);
  const raw = Math.ceil(Math.max(0, fileSizeBytes) / TRANSCRIPTIONS_BITRATE_BYTES_PER_SEC);
  const estimatedSeconds = Math.max(1, Math.min(raw, TRANSCRIPTIONS_MAX_RESERVE_SECONDS));
  const estCents = computePerSecondCents(estimatedSeconds, rate.usdPerMinute);
  return { estCents, estimatedSeconds };
}

export function computeTranscriptionsActualCost(
  reportedSeconds: number,
  model: string,
  config: PricingConfig,
): { actualCents: bigint } {
  const rate = rateForTranscriptionsModel(config.transcriptionsRateCard, model);
  const seconds = Math.max(0, Math.ceil(reportedSeconds));
  const actualCents = computePerSecondCents(seconds, rate.usdPerMinute);
  return { actualCents };
}

function computePerSecondCents(seconds: number, usdPerMinute: number): bigint {
  // cents per second × 10_000 (micro-cents) for precision before round-up.
  // usdPerMinute × 100 cents = cents per minute. /60 = cents per second.
  const microCentsPerSecond = BigInt(Math.round((usdPerMinute * 100 * 10_000) / 60));
  const micro = BigInt(Math.max(0, seconds)) * microCentsPerSecond;
  return (micro + 9999n) / 10_000n;
}
