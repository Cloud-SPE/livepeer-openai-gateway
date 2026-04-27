// Legacy MetricsSink helpers for PrometheusRecorder.
//
// The pre-existing MetricsSink interface (counter/gauge/histogram with
// arbitrary names + labels) is kept alive in Phase 1 so src/service/tokenAudit
// keeps working unmodified. We only allow a small Phase-1 allowlist of metric
// names through; everything else is silently dropped. Phase 2 deletes this
// surface entirely.

import type {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
  Registry,
} from 'prom-client';
import { Counter, Gauge, Histogram } from 'prom-client';

/** Legacy MetricsSink names that survive Phase 1. Anything else is dropped. */
export const ALLOW_LEGACY = new Set<string>([
  'tokens_drift_percent',
  'tokens_local_count',
  'tokens_reported_count',
]);

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class LegacySink {
  private readonly histograms = new Map<string, PromHistogram<string>>();
  private readonly gauges = new Map<string, PromGauge<string>>();
  private readonly counters = new Map<string, PromCounter<string>>();

  constructor(private readonly registry: Registry) {}

  counter(name: string, labelNames: string[]): PromCounter<string> | null {
    if (!ALLOW_LEGACY.has(name)) return null;
    let vec = this.counters.get(name);
    if (!vec) {
      vec = new Counter({
        name,
        help: `Legacy MetricsSink emission: ${name}.`,
        labelNames,
        registers: [this.registry],
      });
      this.counters.set(name, vec);
    }
    return vec;
  }

  gauge(name: string, labelNames: string[]): PromGauge<string> | null {
    if (!ALLOW_LEGACY.has(name)) return null;
    let vec = this.gauges.get(name);
    if (!vec) {
      vec = new Gauge({
        name,
        help: `Legacy MetricsSink emission: ${name}.`,
        labelNames,
        registers: [this.registry],
      });
      this.gauges.set(name, vec);
    }
    return vec;
  }

  histogram(name: string, labelNames: string[]): PromHistogram<string> | null {
    if (!ALLOW_LEGACY.has(name)) return null;
    let vec = this.histograms.get(name);
    if (!vec) {
      vec = new Histogram({
        name,
        help: `Legacy MetricsSink emission: ${name}.`,
        labelNames,
        buckets: [...DEFAULT_BUCKETS],
        registers: [this.registry],
      });
      this.histograms.set(name, vec);
    }
    return vec;
  }
}
