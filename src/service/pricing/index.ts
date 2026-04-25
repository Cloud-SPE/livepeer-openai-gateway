import type { PricingConfig } from '../../config/pricing.js';
import type { CustomerTier } from '../../types/customer.js';
import type { ChatCompletionRequest, Usage } from '../../types/openai.js';
import type { ImageQuality, ImageSize, PricingTier } from '../../types/pricing.js';
import { rateForEmbeddingsModel, rateForImageSku, rateForTier } from '../../config/pricing.js';
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
  const inputCentsPerMillion = BigInt(Math.round(inputUsdPerMillion * 100 * 10_000));
  const outputCentsPerMillion = BigInt(Math.round(outputUsdPerMillion * 100 * 10_000));

  const inputMicro = (promptTokens * inputCentsPerMillion) / MILLION;
  const outputMicro = (outputTokens * outputCentsPerMillion) / MILLION;
  const micro = inputMicro + outputMicro;

  return (micro + 9999n) / 10_000n;
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
