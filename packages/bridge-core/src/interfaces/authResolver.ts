import type { Caller } from './caller.js';

/**
 * Operator-overridable adapter for resolving an inbound HTTP request to a
 * Caller. The engine ships a Fastify pre-handler that calls `resolve` and
 * attaches `req.caller`. Returning `null` causes the pre-handler to send
 * 401; throwing surfaces as a 500 (unless the operator's resolver throws
 * a recognized AuthError-shaped exception).
 *
 * Tier semantics are operator-defined — the engine plumbs the string
 * through but does not interpret it. Operators declare their tier names
 * in pricing config; the resolver returns the matching name.
 */
export interface AuthResolver {
  resolve(req: AuthResolverRequest): Promise<Caller | null>;
}

/**
 * Subset of the inbound request the resolver inspects. Kept framework-free
 * (no Fastify types) so non-Fastify operators can implement it.
 */
export interface AuthResolverRequest {
  headers: Record<string, string | undefined>;
  ip: string;
}
