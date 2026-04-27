import { z } from 'zod';

/**
 * Metrics listener config. `listen` is the `host:port` (or bare `port`) the
 * Prometheus exposition Fastify instance binds to. An empty string disables
 * the listener entirely — the Recorder slot is filled with NoopRecorder and
 * /metrics is never bound.
 *
 * `maxSeriesPerMetric` is the per-metric cardinality cap (0 = disabled).
 *
 * See `livepeer-modules-conventions/port-allocation.md` for the bridge's
 * recommended port (`:9602`). Always bind 127.0.0.1 or an internal-LAN
 * interface — Prometheus exposition contains no auth and must not face the
 * public internet.
 */
export interface MetricsConfig {
  readonly listen: string;
  readonly maxSeriesPerMetric: number;
}

const EnvSchema = z.object({
  METRICS_LISTEN: z.string().default(''),
  METRICS_MAX_SERIES_PER_METRIC: z.coerce.number().int().nonnegative().default(10_000),
});

export function loadMetricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  const parsed = EnvSchema.parse(env);
  return {
    listen: parsed.METRICS_LISTEN,
    maxSeriesPerMetric: parsed.METRICS_MAX_SERIES_PER_METRIC,
  };
}
