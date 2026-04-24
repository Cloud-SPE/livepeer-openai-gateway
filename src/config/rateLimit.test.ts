import { describe, expect, it } from 'vitest';
import { defaultRateLimitConfig, resolvePolicy } from './rateLimit.js';

describe('rate-limit policy config', () => {
  it('ships the v1 free-default and prepaid-default policies', () => {
    const cfg = defaultRateLimitConfig();
    const free = resolvePolicy(cfg, 'free-default');
    expect(free).toMatchObject({ perMinute: 3, perDay: 200, concurrent: 1 });

    const prepaid = resolvePolicy(cfg, 'prepaid-default');
    expect(prepaid).toMatchObject({ perMinute: 60, perDay: 10_000, concurrent: 10 });
  });

  it('falls back to prepaid-default on unknown policy names', () => {
    const cfg = defaultRateLimitConfig();
    const p = resolvePolicy(cfg, 'does-not-exist');
    expect(p.name).toBe('prepaid-default');
  });
});
