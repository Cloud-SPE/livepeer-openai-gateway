import { describe, it, expect } from 'vitest';
import {
  ChatRateCardSchema,
  EmbeddingsRateCardSchema,
  ImagesRateCardSchema,
  PricingTierSchema,
} from '@cloud-spe/bridge-core/types/pricing.js';
import { ChatCompletionRequestSchema } from '@cloud-spe/bridge-core/types/openai.js';
import {
  EmbeddingsRequestSchema,
  EmbeddingsResponseSchema,
  normalizeEmbeddingsInput,
} from '@cloud-spe/bridge-core/types/embeddings.js';
import {
  ImagesGenerationRequestSchema,
  ImagesResponseSchema,
} from '@cloud-spe/bridge-core/types/images.js';
import {
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
} from '@cloud-spe/bridge-core/types/error.js';
import { WorkIdSchema } from '@cloud-spe/bridge-core/types/payment.js';
import { CustomerSchema, CustomerTierSchema } from './customer.js';

describe('types/error', () => {
  it('accepts a well-formed error envelope', () => {
    const parsed = ErrorEnvelopeSchema.parse({
      error: {
        code: 'balance_insufficient',
        message: 'balance too low for estimated request cost',
        type: 'billing_error',
      },
    });
    expect(parsed.error.code).toBe('balance_insufficient');
  });

  it('envelope accepts any string code (wire-compat with OpenAI); strict enum lives in ErrorCodeSchema', () => {
    const envResult = ErrorEnvelopeSchema.safeParse({
      error: { code: 'invalid_api_key', message: 'x', type: 'x' },
    });
    expect(envResult.success).toBe(true);

    const strictResult = ErrorCodeSchema.safeParse('teapot');
    expect(strictResult.success).toBe(false);
  });
});

describe('types/customer', () => {
  it('parses a valid customer record', () => {
    const c = CustomerSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'dev@example.com',
      tier: 'free',
      status: 'active',
      rateLimitTier: 'free-default',
      createdAt: '2026-04-24T00:00:00Z',
    });
    expect(c.tier).toBe('free');
    expect(c.createdAt).toBeInstanceOf(Date);
  });

  it('constrains tier to free or prepaid', () => {
    expect(() => CustomerTierSchema.parse('enterprise')).toThrow();
  });
});

describe('types/pricing', () => {
  it('accepts Starter/Standard/Pro pricing tiers', () => {
    expect(PricingTierSchema.parse('starter')).toBe('starter');
    expect(PricingTierSchema.parse('standard')).toBe('standard');
    expect(PricingTierSchema.parse('pro')).toBe('pro');
  });

  it('chat rate card requires exactly four tier entries (starter, standard, pro, premium)', () => {
    const tiers = ['starter', 'standard', 'pro', 'premium'] as const;
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        tier: tiers[i % tiers.length]!,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      }));
    expect(() =>
      ChatRateCardSchema.parse({ version: 'v1', effectiveAt: new Date(), entries: mk(3) }),
    ).toThrow();
    expect(() =>
      ChatRateCardSchema.parse({ version: 'v1', effectiveAt: new Date(), entries: mk(4) }),
    ).not.toThrow();
  });

  it('embeddings rate card is model-keyed and requires ≥1 entry', () => {
    expect(() =>
      EmbeddingsRateCardSchema.parse({ version: 'v1', effectiveAt: new Date(), entries: [] }),
    ).toThrow();
    const parsed = EmbeddingsRateCardSchema.parse({
      version: 'v1',
      effectiveAt: new Date(),
      entries: [{ model: 'text-embedding-3-small', usdPerMillionTokens: 0.02 }],
    });
    expect(parsed.entries[0]!.model).toBe('text-embedding-3-small');
  });

  it('embeddings rate card rejects non-positive rates', () => {
    const r = EmbeddingsRateCardSchema.safeParse({
      version: 'v1',
      effectiveAt: new Date(),
      entries: [{ model: 'm', usdPerMillionTokens: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('images rate card accepts a (model, size, quality, usdPerImage) entry', () => {
    const parsed = ImagesRateCardSchema.parse({
      version: 'v1',
      effectiveAt: new Date(),
      entries: [
        { model: 'dall-e-3', size: '1024x1024', quality: 'standard', usdPerImage: 0.05 },
      ],
    });
    expect(parsed.entries[0]!.size).toBe('1024x1024');
  });

  it('images rate card rejects an unknown size', () => {
    const r = ImagesRateCardSchema.safeParse({
      version: 'v1',
      effectiveAt: new Date(),
      entries: [{ model: 'x', size: '512x512', quality: 'standard', usdPerImage: 0.01 }],
    });
    expect(r.success).toBe(false);
  });

  it('images rate card rejects an unknown quality', () => {
    const r = ImagesRateCardSchema.safeParse({
      version: 'v1',
      effectiveAt: new Date(),
      entries: [{ model: 'x', size: '1024x1024', quality: 'ultra', usdPerImage: 0.01 }],
    });
    expect(r.success).toBe(false);
  });
});

describe('types/payment', () => {
  it('WorkId is a non-empty string', () => {
    expect(() => WorkIdSchema.parse('')).toThrow();
    expect(WorkIdSchema.parse('cust-1:wrk-2')).toBe('cust-1:wrk-2');
  });
});

describe('types/openai', () => {
  it('parses a chat completions request', () => {
    const req = ChatCompletionRequestSchema.parse({
      model: 'model-small',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(req.messages[0]!.role).toBe('user');
    expect(req.stream_options?.include_usage).toBe(true);
  });

  it('rejects an empty messages array', () => {
    const r = ChatCompletionRequestSchema.safeParse({
      model: 'm',
      messages: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('types/embeddings', () => {
  it('accepts a single-string input', () => {
    const req = EmbeddingsRequestSchema.parse({
      model: 'text-embedding-3-small',
      input: 'hello world',
    });
    expect(req.input).toBe('hello world');
  });

  it('accepts a batched string[] input', () => {
    const req = EmbeddingsRequestSchema.parse({
      model: 'text-embedding-3-small',
      input: ['a', 'b', 'c'],
      encoding_format: 'base64',
      dimensions: 512,
    });
    expect(Array.isArray(req.input)).toBe(true);
  });

  it('rejects an empty input array', () => {
    const r = EmbeddingsRequestSchema.safeParse({ model: 'm', input: [] });
    expect(r.success).toBe(false);
  });

  it('normalizeEmbeddingsInput returns an array regardless of shape', () => {
    expect(normalizeEmbeddingsInput('x')).toEqual(['x']);
    expect(normalizeEmbeddingsInput(['x', 'y'])).toEqual(['x', 'y']);
  });

  it('accepts a valid embeddings response', () => {
    const parsed = EmbeddingsResponseSchema.parse({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
    expect(parsed.data).toHaveLength(1);
  });
});

describe('types/images', () => {
  it('accepts a minimal images request', () => {
    const req = ImagesGenerationRequestSchema.parse({
      model: 'dall-e-3',
      prompt: 'a cat',
    });
    expect(req.prompt).toBe('a cat');
  });

  it('rejects an unknown size', () => {
    const r = ImagesGenerationRequestSchema.safeParse({
      model: 'dall-e-3',
      prompt: 'x',
      size: '512x512',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an over-long prompt', () => {
    const r = ImagesGenerationRequestSchema.safeParse({
      model: 'dall-e-3',
      prompt: 'x'.repeat(5_000),
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid response with url-format images', () => {
    const parsed = ImagesResponseSchema.parse({
      created: 1_700_000_000,
      data: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.png' }],
    });
    expect(parsed.data).toHaveLength(2);
  });
});
