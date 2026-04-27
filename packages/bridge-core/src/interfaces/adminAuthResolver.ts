/**
 * Operator-overridable adapter for the engine's optional read-only
 * operator dashboard (lands in stage 2 / exec-plan 0025). Returns the
 * resolved actor identity on success, `null` on failure (engine sends
 * 401). Default impl in this repo wraps the existing X-Admin-Token +
 * X-Admin-Actor scheme; operators with SSO/OIDC can implement their own.
 */
export interface AdminAuthResolver {
  resolve(req: AdminAuthResolverRequest): Promise<AdminAuthResolverResult | null>;
}

export interface AdminAuthResolverRequest {
  headers: Record<string, string | undefined>;
  ip: string;
}

export interface AdminAuthResolverResult {
  actor: string;
}
