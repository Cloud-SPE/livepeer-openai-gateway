import { z } from 'zod';

export interface AuthConfig {
  readonly pepper: string;
  readonly envPrefix: 'live' | 'test';
  readonly cacheTtlMs: number;
}

const EnvSchema = z.object({
  API_KEY_PEPPER: z.string().min(16, 'API_KEY_PEPPER must be at least 16 chars'),
  API_KEY_ENV_PREFIX: z.enum(['live', 'test']).default('live'),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
});

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = EnvSchema.parse(env);
  return {
    pepper: parsed.API_KEY_PEPPER,
    envPrefix: parsed.API_KEY_ENV_PREFIX,
    cacheTtlMs: parsed.AUTH_CACHE_TTL_MS,
  };
}
