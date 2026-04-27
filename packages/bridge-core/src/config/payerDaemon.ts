import { z } from 'zod';

export interface PayerDaemonConfig {
  readonly socketPath: string;
  readonly healthIntervalMs: number;
  readonly healthFailureThreshold: number;
  readonly callTimeoutMs: number;
  // bridgeEthAddress is the ETH address the payer-daemon's keystore
  // signs for. The bridge sends it as the `?sender=` param on worker
  // /quote and /quotes probes (introduced in 0018-worker-wire-format-alignment).
  // Eventually this could be fetched from the daemon at startup via
  // an extended GetDepositInfo; for phase 1 it's an explicit env var.
  readonly bridgeEthAddress: string;
}

const EnvSchema = z.object({
  PAYER_DAEMON_SOCKET: z.string().min(1).default('/var/run/livepeer/payment.sock'),
  PAYER_DAEMON_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(2),
  PAYER_DAEMON_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  BRIDGE_ETH_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'BRIDGE_ETH_ADDRESS must be a 0x-prefixed 40-hex address'),
});

export function loadPayerDaemonConfig(env: NodeJS.ProcessEnv = process.env): PayerDaemonConfig {
  const parsed = EnvSchema.parse(env);
  return {
    socketPath: parsed.PAYER_DAEMON_SOCKET,
    healthIntervalMs: parsed.PAYER_DAEMON_HEALTH_INTERVAL_MS,
    healthFailureThreshold: parsed.PAYER_DAEMON_HEALTH_FAILURE_THRESHOLD,
    callTimeoutMs: parsed.PAYER_DAEMON_CALL_TIMEOUT_MS,
    bridgeEthAddress: parsed.BRIDGE_ETH_ADDRESS,
  };
}
