import { z } from 'zod';
import type { DatabaseConfig } from '../providers/database.js';

const EnvSchema = z.object({
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string(),
  PGDATABASE: z.string().min(1),
  PGPOOL_MAX: z.coerce.number().int().positive().optional(),
  PGSSL: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
});

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = EnvSchema.parse(env);
  const base: DatabaseConfig = {
    host: parsed.PGHOST,
    port: parsed.PGPORT,
    user: parsed.PGUSER,
    password: parsed.PGPASSWORD,
    database: parsed.PGDATABASE,
  };
  return {
    ...base,
    ...(parsed.PGPOOL_MAX !== undefined ? { max: parsed.PGPOOL_MAX } : {}),
    ...(parsed.PGSSL !== undefined ? { ssl: parsed.PGSSL } : {}),
  };
}
