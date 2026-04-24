import { z } from 'zod';

export interface AdminConfig {
  readonly token: string;
  readonly ipAllowlist: readonly string[];
}

const EnvSchema = z.object({
  ADMIN_TOKEN: z.string().min(32, 'ADMIN_TOKEN must be at least 32 chars'),
  ADMIN_IP_ALLOWLIST: z.string().optional(),
});

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const parsed = EnvSchema.parse(env);
  const ipAllowlist = parsed.ADMIN_IP_ALLOWLIST
    ? parsed.ADMIN_IP_ALLOWLIST.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  return {
    token: parsed.ADMIN_TOKEN,
    ipAllowlist,
  };
}
