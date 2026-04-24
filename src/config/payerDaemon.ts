import { z } from 'zod';

export interface PayerDaemonConfig {
  readonly socketPath: string;
  readonly healthIntervalMs: number;
  readonly healthFailureThreshold: number;
  readonly callTimeoutMs: number;
}

const EnvSchema = z.object({
  PAYER_DAEMON_SOCKET: z.string().min(1).default('/var/run/livepeer/payment.sock'),
  PAYER_DAEMON_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(2),
  PAYER_DAEMON_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export function loadPayerDaemonConfig(env: NodeJS.ProcessEnv = process.env): PayerDaemonConfig {
  const parsed = EnvSchema.parse(env);
  return {
    socketPath: parsed.PAYER_DAEMON_SOCKET,
    healthIntervalMs: parsed.PAYER_DAEMON_HEALTH_INTERVAL_MS,
    healthFailureThreshold: parsed.PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD,
    callTimeoutMs: parsed.PAYER_DAEMON_CALL_TIMEOUT_MS,
  };
}
