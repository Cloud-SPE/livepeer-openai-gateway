import type { MetricsSink } from '../metrics.js';

export function createNoopMetricsSink(): MetricsSink {
  return {
    counter() {
      /* no-op */
    },
    gauge() {
      /* no-op */
    },
    histogram() {
      /* no-op */
    },
  };
}
