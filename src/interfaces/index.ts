/**
 * Barrel for the engine's operator-overridable adapter contracts.
 *
 * Engine-internal provider interfaces (e.g. ServiceRegistryClient) live
 * in `src/providers/` instead — they are NOT operator-overridable.
 *
 * See exec-plan 0024 for the locked-in shapes.
 */
export type { Caller, CostQuote, UsageReport, ReservationHandle } from './caller.js';
export type { Wallet } from './wallet.js';
export type { AuthResolver, AuthResolverRequest } from './authResolver.js';
export type {
  RateLimiter,
  RateLimitHeaders,
  RateLimitCheckResult,
} from './rateLimiter.js';
export type { Logger } from './logger.js';
export type {
  AdminAuthResolver,
  AdminAuthResolverRequest,
  AdminAuthResolverResult,
} from './adminAuthResolver.js';
