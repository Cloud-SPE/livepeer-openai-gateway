import type {
  AuthResolver,
  AuthResolverRequest,
  Caller,
} from '@cloudspe/livepeer-openai-gateway-core/interfaces/index.js';
import type { AuthenticatedCaller, AuthService } from './authenticate.js';
import { AuthError } from '@cloudspe/livepeer-openai-gateway-core/service/auth/errors.js';

export interface AuthResolverDeps {
  authService: AuthService;
}

/**
 * Default `AuthResolver` impl wrapping the existing `AuthService` (Bearer
 * api-key validation backed by the `customers`/`api_key` tables). Maps
 * `AuthError`-shaped failures to `null`, which the engine's Fastify
 * pre-handler translates to a 401 with `code: 'authentication_failed'`.
 *
 * Caller shape:
 *   - id             = customer.id
 *   - tier           = customer.tier (billing tier: 'free' | 'prepaid')
 *   - rateLimitTier  = customer.rateLimitTier (per-customer rate-limit class)
 *   - metadata       = { customer, apiKey } — shell-side consumers narrow
 *     via `caller.metadata as AuthenticatedCaller` to reach customer-only
 *     fields the engine's Caller doesn't expose (e.g. status).
 *
 * Other (non-AuthError) errors propagate; they surface as 500 by Fastify's
 * default handler.
 *
 * Locked-in by exec-plan 0024.
 */
export function createAuthResolver(deps: AuthResolverDeps): AuthResolver {
  return {
    async resolve(req: AuthResolverRequest): Promise<Caller | null> {
      try {
        const inner = await deps.authService.authenticate(req.headers.authorization);
        return toCaller(inner);
      } catch (err) {
        if (err instanceof AuthError) return null;
        throw err;
      }
    },
  };
}

export function toCaller(inner: AuthenticatedCaller): Caller {
  return {
    id: inner.customer.id,
    tier: inner.customer.tier,
    rateLimitTier: inner.customer.rateLimitTier,
    metadata: inner,
  };
}
