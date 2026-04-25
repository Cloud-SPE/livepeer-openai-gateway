// CapVec wraps a prom-client Counter / Gauge / Histogram vec with cardinality
// enforcement. The set of seen label tuples is tracked in a Set keyed by a
// space-joined label tuple. Once `maxSeries` is reached, new tuples are
// silently dropped (existing tuples keep updating) and the optional
// onCapExceeded callback fires exactly once per metric.
//
// Operations:
//   inc(...labels)          — Counter
//   add(delta, ...labels)   — Counter, accumulating arbitrary deltas
//   set(value, ...labels)   — Gauge
//   observe(value, ...lbls) — Histogram
//
// Set maxSeries = 0 to disable the cap entirely.

import type {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
} from 'prom-client';

type AnyVec = PromCounter<string> | PromGauge<string> | PromHistogram<string>;

export class CapVec<V extends AnyVec> {
  private readonly seen = new Set<string>();
  private exceeded = false;

  constructor(
    private readonly name: string,
    private readonly vec: V,
    private readonly maxSeries: number,
    private readonly onExceed?: (name: string, observed: number, max: number) => void,
  ) {}

  /** Returns the underlying vec at the given labels, or null if dropped by the cap. */
  private gate(labels: readonly string[]): V | null {
    if (this.maxSeries <= 0) return this.vec;
    const key = labels.join(' ');
    if (this.seen.has(key)) return this.vec;
    if (this.seen.size >= this.maxSeries) {
      if (!this.exceeded) {
        this.exceeded = true;
        if (this.onExceed) this.onExceed(this.name, this.seen.size, this.maxSeries);
      }
      return null;
    }
    this.seen.add(key);
    return this.vec;
  }

  inc(...labels: string[]): void {
    const v = this.gate(labels);
    if (!v) return;
    (v as PromCounter<string>).labels(...labels).inc();
  }

  add(delta: number, ...labels: string[]): void {
    const v = this.gate(labels);
    if (!v) return;
    (v as PromCounter<string>).labels(...labels).inc(delta);
  }

  set(value: number, ...labels: string[]): void {
    const v = this.gate(labels);
    if (!v) return;
    (v as PromGauge<string>).labels(...labels).set(value);
  }

  observe(value: number, ...labels: string[]): void {
    const v = this.gate(labels);
    if (!v) return;
    (v as PromHistogram<string>).labels(...labels).observe(value);
  }
}
