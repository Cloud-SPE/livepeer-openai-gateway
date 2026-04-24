import type { PricingConfig } from '../../config/pricing.js';
import type { CustomerTier } from '../../types/customer.js';
import type { ChatCompletionRequest, Usage } from '../../types/openai.js';
import type { PricingTier } from '../../types/pricing.js';
import { rateForTier } from '../../config/pricing.js';
import { ModelNotFoundError } from '../routing/errors.js';

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
): ReservationEstimate {
  const pricingTier = resolveTierForModel(config, req.model);
  const rate = rateForTier(config.rateCard, pricingTier);

  const charCount = req.messages.reduce((sum, m) => sum + m.content.length, 0);
  const promptEstimateTokens = Math.max(1, Math.ceil(charCount / 3));

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
