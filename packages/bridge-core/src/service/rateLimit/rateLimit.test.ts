import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestRedis, type TestRedis } from './testRedis.js';
import { createRateLimiter } from './index.js';
import { RateLimitExceededError } from './errors.js';
import { defaultRateLimitConfig } from '../../config/rateLimit.js';

let redis: TestRedis;
const cfg = defaultRateLimitConfig();

beforeAll(async () => {
  redis = await startTestRedis();
});
afterAll(async () => {
  if (redis) await redis.close();
});
beforeEach(async () => {
  // Wipe all rate-limit keys between tests — simplest via FLUSHDB (test DB only).
  await redis.client.eval('return redis.call("FLUSHDB")', [], []);
});

describe('rate limiter: sliding-window + concurrency (real Redis)', () => {
  it('allows up to limit and 429s the next request with retry_after', async () => {
    const limiter = createRateLimiter({ redis: redis.client, config: cfg });
    const customerId = 'cust-ok';

    // free-default: 3/min.
    for (let i = 0; i < 3; i++) {
      const r = await limiter.check(customerId, 'free-default');
      expect(r.headers.limitRequests).toBe(3);
      expect(r.failedOpen).toBe(false);
      await limiter.release(r.concurrencyKey, r.failedOpen);
    }

    await expect(limiter.check(customerId, 'free-default')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it('429s on concurrent cap and recovers on release', async () => {
    const limiter = createRateLimiter({ redis: redis.client, config: cfg });
    const customerId = 'cust-conc';

    // free-default: concurrent=1.
    const first = await limiter.check(customerId, 'free-default');
    // Do NOT release — simulating an in-flight request.
    await expect(limiter.check(customerId, 'free-default')).rejects.toMatchObject({
      reason: 'concurrent',
    });
    await limiter.release(first.concurrencyKey, first.failedOpen);

    const again = await limiter.check(customerId, 'free-default');
    expect(again.failedOpen).toBe(false);
    await limiter.release(again.concurrencyKey, again.failedOpen);
  });

  it('different customers do not interfere', async () => {
    const limiter = createRateLimiter({ redis: redis.client, config: cfg });
    const a = await limiter.check('cust-a', 'free-default');
    const b = await limiter.check('cust-b', 'free-default');
    expect(a.headers.remainingRequests).toBe(2);
    expect(b.headers.remainingRequests).toBe(2);
    await limiter.release(a.concurrencyKey, false);
    await limiter.release(b.concurrencyKey, false);
  });

  it('fails open when Redis throws on every call', async () => {
    const broken = {
      eval: async () => {
        throw new Error('redis down');
      },
      incr: async () => {
        throw new Error('redis down');
      },
      decr: async () => 0,
      expire: async () => 0,
      ping: async () => 'PONG',
      close: async () => undefined,
    };
    const limiter = createRateLimiter({ redis: broken, config: cfg });
    const r = await limiter.check('cust-fail', 'free-default');
    expect(r.failedOpen).toBe(true);
  });

  it('release is a no-op when fail-open', async () => {
    const broken = {
      eval: async () => {
        throw new Error('redis down');
      },
      incr: async () => {
        throw new Error('redis down');
      },
      decr: async () => 0,
      expire: async () => 0,
      ping: async () => 'PONG',
      close: async () => undefined,
    };
    const limiter = createRateLimiter({ redis: broken, config: cfg });
    const r = await limiter.check('cust-fo', 'free-default');
    await limiter.release(r.concurrencyKey, r.failedOpen);
    // Should complete without throwing.
  });

  it('resetSeconds is bounded between 0 and window', async () => {
    const limiter = createRateLimiter({ redis: redis.client, config: cfg });
    const r = await limiter.check('cust-reset', 'free-default');
    expect(r.headers.resetSeconds).toBeGreaterThanOrEqual(0);
    expect(r.headers.resetSeconds).toBeLessThanOrEqual(60);
    await limiter.release(r.concurrencyKey, false);
  });
});
