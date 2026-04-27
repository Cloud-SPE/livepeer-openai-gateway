export type MetricLabels = Readonly<Record<string, string | number>>;

export interface MetricsSink {
  counter(name: string, labels: MetricLabels, delta?: number): void;
  gauge(name: string, labels: MetricLabels, value: number): void;
  histogram(name: string, labels: MetricLabels, value: number): void;
}
