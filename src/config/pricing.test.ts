import { describe, expect, it } from 'vitest';
import { defaultPricingConfig, loadPricingConfig, rateForTier } from './pricing.js';

describe('pricing config', () => {
  it('default pricing config matches the v2 rate card (4 tiers including premium)', () => {
    const cfg = defaultPricingConfig();
    expect(cfg.rateCard.entries).toHaveLength(4);
    const starter = rateForTier(cfg.rateCard, 'starter');
    expect(starter.inputUsdPerMillion).toBe(0.05);
    expect(starter.outputUsdPerMillion).toBe(0.1);
    const pro = rateForTier(cfg.rateCard, 'pro');
    expect(pro.outputUsdPerMillion).toBe(1.2);
    // premium: targets niche / fine-tune / single-user-serving workers;
    // positioned BELOW gpt-4o ($2.50/$10) and Claude Sonnet ($3/$15).
    const premium = rateForTier(cfg.rateCard, 'premium');
    expect(premium.inputUsdPerMillion).toBe(2.5);
    expect(premium.outputUsdPerMillion).toBe(6.0);
  });

  it('resolves model → tier using the default map', () => {
    const cfg = defaultPricingConfig();
    expect(cfg.modelToTier.get('model-small')).toBe('starter');
    expect(cfg.modelToTier.get('model-medium')).toBe('standard');
    expect(cfg.modelToTier.get('model-large')).toBe('pro');
    expect(cfg.modelToTier.get('model-premium')).toBe('premium');
  });

  it('loadPricingConfig applies env overrides for default max tokens', () => {
    const cfg = loadPricingConfig({
      PRICING_DEFAULT_MAX_TOKENS_FREE: '512',
      PRICING_DEFAULT_MAX_TOKENS_PREPAID: '2048',
    } as NodeJS.ProcessEnv);
    expect(cfg.defaultMaxTokensFree).toBe(512);
    expect(cfg.defaultMaxTokensPrepaid).toBe(2048);
  });

  it('falls back to defaults when env is empty', () => {
    const cfg = loadPricingConfig({} as NodeJS.ProcessEnv);
    expect(cfg.defaultMaxTokensFree).toBe(1024);
    expect(cfg.defaultMaxTokensPrepaid).toBe(4096);
  });
});
