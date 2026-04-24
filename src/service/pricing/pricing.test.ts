import { describe, expect, it } from 'vitest';
import { defaultPricingConfig } from '../../config/pricing.js';
import { computeActualCost, estimateReservation, resolveTierForModel } from './index.js';
import { ModelNotFoundError } from '../routing/errors.js';

const cfg = defaultPricingConfig();

describe('resolveTierForModel', () => {
  it('returns the tier for a known model', () => {
    expect(resolveTierForModel(cfg, 'model-small')).toBe('starter');
    expect(resolveTierForModel(cfg, 'model-large')).toBe('pro');
  });

  it('throws ModelNotFoundError for unknown models', () => {
    expect(() => resolveTierForModel(cfg, 'nonexistent')).toThrow(ModelNotFoundError);
  });
});

describe('estimateReservation', () => {
  it('conservative upper-bound for prepaid', () => {
    const est = estimateReservation(
      {
        model: 'model-small',
        messages: [{ role: 'user', content: 'x'.repeat(30) }],
        max_tokens: 1000,
      },
      'prepaid',
      cfg,
    );
    expect(est.pricingTier).toBe('starter');
    expect(est.promptEstimateTokens).toBe(10);
    expect(est.maxCompletionTokens).toBe(1000);
    // 10 × $0.20/1M + 1000 × $0.60/1M = $0.000002 + $0.0006 = $0.000602
    // In cents: 0.0602 cents → ceil to 1 cent.
    expect(est.estCents).toBe(1n);
  });

  it('uses the tier-default max_tokens when caller omits it', () => {
    const free = estimateReservation(
      { model: 'model-small', messages: [{ role: 'user', content: 'hi' }] },
      'free',
      cfg,
    );
    expect(free.maxCompletionTokens).toBe(cfg.defaultMaxTokensFree);

    const prepaid = estimateReservation(
      { model: 'model-small', messages: [{ role: 'user', content: 'hi' }] },
      'prepaid',
      cfg,
    );
    expect(prepaid.maxCompletionTokens).toBe(cfg.defaultMaxTokensPrepaid);
  });

  it('rejects unknown models via ModelNotFoundError', () => {
    expect(() =>
      estimateReservation(
        { model: 'missing', messages: [{ role: 'user', content: 'hi' }] },
        'prepaid',
        cfg,
      ),
    ).toThrow(ModelNotFoundError);
  });
});

describe('computeActualCost', () => {
  it('charges per-tier input + output rates', () => {
    // model-large → pro tier: input $3/1M, output $10/1M.
    // 100 prompt + 200 completion = 100 × $3/1M + 200 × $10/1M
    //                             = $0.0003 + $0.002 = $0.0023
    //                             = 0.23 cents → ceil to 1 cent.
    const c = computeActualCost(
      { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      'prepaid',
      'model-large',
      cfg,
    );
    expect(c.actualCents).toBe(1n);
    expect(c.pricingTier).toBe('pro');
  });

  it('returns integer cents (round up) for large token counts', () => {
    // model-medium → standard: $1/1M input, $3/1M output.
    // 1_000_000 + 1_000_000 = $1 + $3 = $4.00 → 400 cents.
    const c = computeActualCost(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      'prepaid',
      'model-medium',
      cfg,
    );
    expect(c.actualCents).toBe(400n);
  });
});
