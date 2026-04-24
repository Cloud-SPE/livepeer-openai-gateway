import { z } from 'zod';
import type { RedisConfig } from '../providers/redis.js';

const EnvSchema = z.object({
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().nonnegative().optional(),
});

export function loadRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const parsed = EnvSchema.parse(env);
  const base: RedisConfig = {
    host: parsed.REDIS_HOST,
    port: parsed.REDIS_PORT,
  };
  return {
    ...base,
    ...(parsed.REDIS_PASSWORD !== undefined ? { password: parsed.REDIS_PASSWORD } : {}),
    ...(parsed.REDIS_DB !== undefined ? { db: parsed.REDIS_DB } : {}),
  };
}
