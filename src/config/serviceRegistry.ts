import { z } from 'zod';

export interface ServiceRegistryConfig {
  /** Unix socket path. When `address` is set, takes precedence. */
  readonly socketPath: string;
  /** Optional TCP address (host:port) — preferred when set. */
  readonly address: string | null;
  readonly healthIntervalMs: number;
  readonly healthFailureThreshold: number;
  readonly callTimeoutMs: number;
}

const EnvSchema = z.object({
  SERVICE_REGISTRY_SOCKET: z
    .string()
    .min(1)
    .default('/var/run/livepeer/service-registry.sock'),
  SERVICE_REGISTRY_ADDRESS: z.string().min(1).optional(),
  SERVICE_REGISTRY_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  SERVICE_REGISTRY_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(2),
  SERVICE_REGISTRY_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export function loadServiceRegistryConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServiceRegistryConfig {
  const parsed = EnvSchema.parse(env);
  return {
    socketPath: parsed.SERVICE_REGISTRY_SOCKET,
    address: parsed.SERVICE_REGISTRY_ADDRESS ?? null,
    healthIntervalMs: parsed.SERVICE_REGISTRY_HEALTH_INTERVAL_MS,
    healthFailureThreshold: parsed.SERVICE_REGISTRY_HEALTH_FAILURE_THRESHOLD,
    callTimeoutMs: parsed.SERVICE_REGISTRY_CALL_TIMEOUT_MS,
  };
}
