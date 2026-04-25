import { describe, expect, it } from 'vitest';
import { defaultPricingConfig } from '../../config/pricing.js';
import {
  computeActualCost,
  computeEmbeddingsActualCost,
  computeImagesActualCost,
  estimateEmbeddingsReservation,
  estimateImagesReservation,
  estimateReservation,
  resolveTierForModel,
} from './index.js';
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
    // model-medium → standard (v2): $0.15/1M input, $0.40/1M output.
    // 1_000_000 + 1_000_000 = $0.15 + $0.40 = $0.55 → 55 cents.
    const c = computeActualCost(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      'prepaid',
      'model-medium',
      cfg,
    );
    expect(c.actualCents).toBe(55n);
  });
});

describe('estimateEmbeddingsReservation', () => {
  it('estimates with a char-div-3 upper bound and model rate', () => {
    // 30 chars / 3 = 10 tokens at $0.025/1M → well below 1¢; result rounds to 0¢
    const est = estimateEmbeddingsReservation(
      ['x'.repeat(30)],
      'text-embedding-3-small',
      cfg,
    );
    expect(est.promptEstimateTokens).toBe(10);
    expect(est.estCents).toBe(0n);
  });

  it('rounds sub-cent embeddings cost up to 1¢ when non-zero', () => {
    // 300_000 chars / 3 = 100_000 tokens × $0.025/1M = $0.0025 = 0.25¢ → ceil 1¢
    const est = estimateEmbeddingsReservation(
      ['x'.repeat(300_000)],
      'text-embedding-3-small',
      cfg,
    );
    expect(est.promptEstimateTokens).toBe(100_000);
    expect(est.estCents).toBe(1n);
  });

  it('sums across batched inputs', () => {
    const est = estimateEmbeddingsReservation(
      ['x'.repeat(30), 'y'.repeat(60)],
      'text-embedding-3-large',
      cfg,
    );
    expect(est.promptEstimateTokens).toBe(30);
  });

  it('throws for unknown embeddings model', () => {
    expect(() =>
      estimateEmbeddingsReservation(['hi'], 'nonexistent-emb-model', cfg),
    ).toThrow();
  });
});

describe('computeEmbeddingsActualCost', () => {
  it('charges input tokens only at the model rate', () => {
    // 1_000_000 tokens × $0.05/1M (v2) = $0.05 = 5¢
    const c = computeEmbeddingsActualCost(1_000_000, 'text-embedding-3-large', cfg);
    expect(c.actualCents).toBe(5n);
  });
});

describe('estimateImagesReservation', () => {
  it('reserves n × per-image cents (model, size, quality)', () => {
    // dall-e-3 1024x1024 standard (v2) = $0.025 = 3¢ (ceil), × 3 images = 9¢ ... wait
    // $0.025/img → 2.5¢ → ceil 3¢ per image. 3 × 3¢ = 9¢. But pre-multiply
    // the integer math: chars = 3 × 250 micro-cents = 750 micro-cents → 1¢. Hmm
    // Per-image cents from the actual computePerImageCents pipeline:
    // micro = round(0.025 × 100 × 10000) = 25_000; (25000 + 9999) / 10000 = 3.
    // So perImageCents = 3, estCents = 3 × 3 = 9.
    const est = estimateImagesReservation(3, 'dall-e-3', '1024x1024', 'standard', cfg);
    expect(est.perImageCents).toBe(3n);
    expect(est.estCents).toBe(9n);
  });

  it('throws for unknown (model, size, quality) combination', () => {
    expect(() =>
      estimateImagesReservation(1, 'dall-e-3', '1024x1024', 'hd', cfg),
    ).not.toThrow();
    expect(() =>
      estimateImagesReservation(1, 'nonexistent', '1024x1024', 'standard', cfg),
    ).toThrow();
  });
});

describe('computeImagesActualCost', () => {
  it('bills at returned count × per-image rate', () => {
    // 2 images × $0.05 = $0.10 = 10¢ (hd, v2)
    const c = computeImagesActualCost(2, 'dall-e-3', '1024x1024', 'hd', cfg);
    expect(c.actualCents).toBe(10n);
    expect(c.perImageCents).toBe(5n);
  });
});
