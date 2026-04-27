import { describe, expect, it } from 'vitest';
import { loadStripeConfig } from './stripe.js';

const base: NodeJS.ProcessEnv = {
  STRIPE_SECRET_KEY: 'sk_test_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_def',
  STRIPE_SUCCESS_URL: 'https://example.com/success',
  STRIPE_CANCEL_URL: 'https://example.com/cancel',
} as NodeJS.ProcessEnv;

describe('loadStripeConfig', () => {
  it('defaults min and max cents to 500 / 50000', () => {
    const cfg = loadStripeConfig(base);
    expect(cfg.priceMinCents).toBe(500);
    expect(cfg.priceMaxCents).toBe(50_000);
  });

  it('respects env overrides for price bounds', () => {
    const cfg = loadStripeConfig({
      ...base,
      STRIPE_PRICE_MIN_CENTS: '1000',
      STRIPE_PRICE_MAX_CENTS: '100000',
    } as NodeJS.ProcessEnv);
    expect(cfg.priceMinCents).toBe(1000);
    expect(cfg.priceMaxCents).toBe(100_000);
  });

  it('rejects when required env is missing', () => {
    expect(() =>
      loadStripeConfig({
        STRIPE_SECRET_KEY: 'sk',
        STRIPE_WEBHOOK_SECRET: '',
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
