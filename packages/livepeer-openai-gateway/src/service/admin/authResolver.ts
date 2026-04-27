import { createHash, timingSafeEqual } from 'node:crypto';
import type { AdminConfig } from '../../config/admin.js';
import type {
  AdminAuthResolver,
  AdminAuthResolverRequest,
  AdminAuthResolverResult,
} from '@cloudspe/livepeer-gateway-core/interfaces/index.js';

export interface AdminAuthResolverDeps {
  config: AdminConfig;
}

/**
 * Default `AdminAuthResolver` impl wrapping the X-Admin-Token (sha256
 * timing-safe compare) + X-Admin-Actor (regex-bounded handle) scheme used
 * by the existing operator-admin middleware. Returns `{actor}` on success
 * (preferring the X-Admin-Actor header when well-formed, otherwise a
 * truncated token-hash) and `null` on failure.
 *
 * Failure cases:
 *   - missing or wrong-length X-Admin-Token
 *   - X-Admin-Token doesn't match the configured token (timing-safe)
 *   - configured ipAllowlist non-empty AND request IP is not in it
 *
 * The Fastify middleware that consumes this resolver is responsible for
 * writing audit events on both success and rejection — that's a shell
 * concern (the audit table lives shell-side post-split).
 */
export function createAdminAuthResolver(deps: AdminAuthResolverDeps): AdminAuthResolver {
  const expectedHash = createHash('sha256').update(deps.config.token).digest();

  return {
    async resolve(req: AdminAuthResolverRequest): Promise<AdminAuthResolverResult | null> {
      const token = req.headers['x-admin-token'];
      if (!token || token.length !== deps.config.token.length) return null;

      const provided = createHash('sha256').update(token).digest();
      if (!timingSafeEqual(provided, expectedHash)) return null;

      if (deps.config.ipAllowlist.length > 0 && !deps.config.ipAllowlist.includes(req.ip)) {
        return null;
      }

      const actorHeader = req.headers['x-admin-actor'];
      const actor =
        typeof actorHeader === 'string' && ADMIN_ACTOR_PATTERN.test(actorHeader)
          ? actorHeader
          : actorFromToken(token);
      return { actor };
    },
  };
}

// Bounded free-text — keeps the audit column useful (recognizable handles,
// not opaque hashes) without inviting injection or unbounded growth. Mirrors
// the regex documented in 0023's plan and the existing adminAuth middleware.
const ADMIN_ACTOR_PATTERN = /^[a-z0-9._-]{1,64}$/;

function actorFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}
