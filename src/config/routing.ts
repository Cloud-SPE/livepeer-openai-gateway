import { z } from 'zod';
import type { CircuitBreakerConfig } from './nodes.js';

/**
 * Bridge-local routing config. Replaces the per-node refresh + breaker
 * tuning that lived in `nodes.yaml` (since the registry-daemon is the
 * source of node identity now, per-node tuning collapses to global).
 */
export interface RoutingConfig {
  /** Seconds between scheduled `/quotes` polls per node. */
  readonly quoteRefreshSeconds: number;
  /** Timeout for `/health` probes against workers. */
  readonly healthTimeoutMs: number;
  /** Timeout for `/quotes` polls against workers. */
  readonly quoteTimeoutMs: number;
  /** Per-process circuit-breaker policy. */
  readonly circuitBreaker: CircuitBreakerConfig;
}

const EnvSchema = z.object({
  ROUTING_QUOTE_REFRESH_SECONDS: z.coerce.number().int().positive().default(30),
  ROUTING_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  ROUTING_QUOTE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ROUTING_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  ROUTING_CIRCUIT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(300),
});

export function loadRoutingConfig(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  const parsed = EnvSchema.parse(env);
  return {
    quoteRefreshSeconds: parsed.ROUTING_QUOTE_REFRESH_SECONDS,
    healthTimeoutMs: parsed.ROUTING_HEALTH_TIMEOUT_MS,
    quoteTimeoutMs: parsed.ROUTING_QUOTE_TIMEOUT_MS,
    circuitBreaker: {
      failureThreshold: parsed.ROUTING_CIRCUIT_FAILURE_THRESHOLD,
      coolDownSeconds: parsed.ROUTING_CIRCUIT_COOLDOWN_SECONDS,
    },
  };
}
