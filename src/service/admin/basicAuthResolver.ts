import { timingSafeEqual } from 'node:crypto';
import type {
  AdminAuthResolver,
  AdminAuthResolverRequest,
  AdminAuthResolverResult,
} from '../../interfaces/index.js';

/**
 * Default `AdminAuthResolver` for the engine's optional read-only
 * operator dashboard. HTTP Basic auth from env vars; intended for
 * solo / small operators running the OSS engine without a token-issuing
 * shell. The shell's token-based AdminAuthResolver
 * (`src/service/admin/authResolver.ts`) is preferred for production.
 *
 * Env:
 *   BRIDGE_OPS_USER  — username (required when this resolver is wired)
 *   BRIDGE_OPS_PASS  — password (required when this resolver is wired)
 *
 * Returns `{actor: user}` on a valid credential, `null` otherwise. The
 * dashboard plugin replies 401 with a `WWW-Authenticate: Basic ...`
 * header when this returns null, so browsers re-prompt.
 *
 * Per exec-plan 0025.
 */
export interface BasicAdminAuthResolverDeps {
  user: string;
  pass: string;
  realm?: string;
}

export function createBasicAdminAuthResolver(
  deps: BasicAdminAuthResolverDeps,
): AdminAuthResolver {
  const expectedUser = Buffer.from(deps.user, 'utf8');
  const expectedPass = Buffer.from(deps.pass, 'utf8');
  return {
    async resolve(req: AdminAuthResolverRequest): Promise<AdminAuthResolverResult | null> {
      const header = req.headers['authorization'];
      if (!header || !header.toLowerCase().startsWith('basic ')) return null;
      const payload = header.slice('basic '.length).trim();
      let decoded: string;
      try {
        decoded = Buffer.from(payload, 'base64').toString('utf8');
      } catch {
        return null;
      }
      const idx = decoded.indexOf(':');
      if (idx < 0) return null;
      const user = Buffer.from(decoded.slice(0, idx), 'utf8');
      const pass = Buffer.from(decoded.slice(idx + 1), 'utf8');
      if (
        user.length !== expectedUser.length ||
        pass.length !== expectedPass.length ||
        !timingSafeEqual(user, expectedUser) ||
        !timingSafeEqual(pass, expectedPass)
      ) {
        return null;
      }
      return { actor: deps.user };
    },
  };
}

export const BASIC_AUTH_REALM_DEFAULT = 'bridge-operator-dashboard';
