import type { RateLimitPolicy } from '../config/rateLimit.js';

export interface RateLimitHeaders {
  limitRequests: number;
  remainingRequests: number;
  resetSeconds: number;
}

export interface RateLimitCheckResult {
  policy: RateLimitPolicy;
  headers: RateLimitHeaders;
  concurrencyKey: string;
  failedOpen: boolean;
}

/**
 * Operator-overridable adapter. The default impl ships a Redis sliding
 * window keyed by `callerId`; operators may swap for Cloudflare-side
 * limiting (no in-process check), per-tenant quotas, or other strategies.
 * Wired as an OPTIONAL dep on engine routes — pass `undefined` to disable
 * in-process rate limiting entirely.
 */
export interface RateLimiter {
  check(callerId: string, policyName: string): Promise<RateLimitCheckResult>;
  release(concurrencyKey: string, failedOpen: boolean): Promise<void>;
}
