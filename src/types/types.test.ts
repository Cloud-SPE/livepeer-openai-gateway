import { describe, it, expect } from 'vitest';
import {
  ChatCompletionRequestSchema,
  CustomerSchema,
  CustomerTierSchema,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  NodeConfigSchema,
  PricingTierSchema,
  RateCardSchema,
  WorkIdSchema,
} from './index.js';

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

  it('rate card requires exactly three tier entries', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        tier: (['starter', 'standard', 'pro'] as const)[i % 3]!,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      }));
    expect(() =>
      RateCardSchema.parse({ version: 'v1', effectiveAt: new Date(), entries: mk(2) }),
    ).toThrow();
    expect(() =>
      RateCardSchema.parse({ version: 'v1', effectiveAt: new Date(), entries: mk(3) }),
    ).not.toThrow();
  });
});

describe('types/node', () => {
  it('validates a minimal NodeConfig', () => {
    const cfg = NodeConfigSchema.parse({
      id: 'node-a',
      url: 'https://node-a.example.com',
      ethAddress: '0x' + 'ab'.repeat(20),
      supportedModels: ['model-small'],
      enabled: true,
      tierAllowed: ['free', 'prepaid'],
      weight: 100,
    });
    expect(cfg.supportedModels).toHaveLength(1);
  });

  it('rejects a malformed eth address', () => {
    const result = NodeConfigSchema.safeParse({
      id: 'node-a',
      url: 'https://node-a.example.com',
      ethAddress: '0xNOTHEX',
      supportedModels: ['m'],
      enabled: true,
      tierAllowed: ['free'],
      weight: 1,
    });
    expect(result.success).toBe(false);
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
