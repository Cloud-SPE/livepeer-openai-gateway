import { randomUUID } from 'node:crypto';
import type { RedisClient } from '../../providers/redis.js';
import type { RateLimitConfig } from '../../config/rateLimit.js';
import { resolvePolicy } from '../../config/rateLimit.js';
import { NoopRecorder } from '../../providers/metrics/noop.js';
import {
  RATE_LIMIT_CONCURRENT,
  RATE_LIMIT_RPD,
  RATE_LIMIT_RPM,
  type RateLimitKind,
  type Recorder,
} from '../../providers/metrics/recorder.js';
import type {
  RateLimitCheckResult,
  RateLimitHeaders,
  RateLimiter,
} from '../../interfaces/index.js';
import { RateLimitExceededError } from './errors.js';
import { acquireSlot, releaseSlot } from './concurrency.js';
import { checkWindow, type WindowResult } from './slidingWindow.js';

export * from './errors.js';
export type { RateLimitCheckResult, RateLimitHeaders, RateLimiter };

export interface RateLimiterDeps {
  redis: RedisClient;
  config: RateLimitConfig;
  /** Recorder for rate-limit-rejection counters. Defaults to the noop. */
  recorder?: Recorder;
  now?: () => number;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const now = deps.now ?? (() => Date.now());
  const recorder: Recorder = deps.recorder ?? new NoopRecorder();

  function emitReject(tier: string, kind: RateLimitKind): void {
    recorder.incRateLimitRejection(tier, kind);
  }

  return {
    async check(callerId, policyName) {
      const policy = resolvePolicy(deps.config, policyName);
      const concurrencyKey = `rl:${callerId}:concurrent`;
      const minuteKey = `rl:${callerId}:min`;
      const dayKey = `rl:${callerId}:day`;
      const member = `${now()}:${randomUUID()}`;

      let minute: WindowResult;
      let day: WindowResult;
      try {
        [minute, day] = await Promise.all([
          checkWindow(deps.redis, minuteKey, policy.perMinute, 60_000, now(), member),
          checkWindow(deps.redis, dayKey, policy.perDay, 86_400_000, now(), member),
        ]);
      } catch {
        return {
          policy,
          headers: {
            limitRequests: policy.perMinute,
            remainingRequests: policy.perMinute,
            resetSeconds: 60,
          },
          concurrencyKey,
          failedOpen: true,
        };
      }

      if (!minute.allowed) {
        emitReject(policy.name, RATE_LIMIT_RPM);
        throw new RateLimitExceededError(
          callerId,
          policy.name,
          'per_minute',
          policy.perMinute,
          minute.resetSeconds,
        );
      }
      if (!day.allowed) {
        emitReject(policy.name, RATE_LIMIT_RPD);
        throw new RateLimitExceededError(
          callerId,
          policy.name,
          'per_day',
          policy.perDay,
          day.resetSeconds,
        );
      }

      try {
        const slot = await acquireSlot(deps.redis, concurrencyKey, policy.concurrent);
        if (!slot.acquired) {
          emitReject(policy.name, RATE_LIMIT_CONCURRENT);
          throw new RateLimitExceededError(
            callerId,
            policy.name,
            'concurrent',
            policy.concurrent,
            1,
          );
        }
      } catch (err) {
        if (err instanceof RateLimitExceededError) throw err;
        return {
          policy,
          headers: {
            limitRequests: policy.perMinute,
            remainingRequests: Math.max(0, minute.limit - minute.count),
            resetSeconds: minute.resetSeconds,
          },
          concurrencyKey,
          failedOpen: true,
        };
      }

      return {
        policy,
        headers: {
          limitRequests: policy.perMinute,
          remainingRequests: Math.max(0, minute.limit - minute.count),
          resetSeconds: minute.resetSeconds,
        },
        concurrencyKey,
        failedOpen: false,
      };
    },

    async release(concurrencyKey, failedOpen) {
      if (failedOpen) return;
      try {
        await releaseSlot(deps.redis, concurrencyKey);
      } catch {
        // Best-effort; TTL safety net catches orphaned slots.
      }
    },
  };
}
