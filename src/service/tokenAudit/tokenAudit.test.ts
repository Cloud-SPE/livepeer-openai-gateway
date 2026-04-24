import { describe, expect, it } from 'vitest';
import { createTiktokenProvider } from '../../providers/tokenizer/tiktoken.js';
import { createNoopMetricsSink } from '../../providers/metrics/noop.js';
import type { MetricsSink, MetricLabels } from '../../providers/metrics.js';
import { computeDriftPercent, createTokenAuditService } from './index.js';

function capturingSink(): MetricsSink & {
  histograms: Array<{ name: string; labels: MetricLabels; value: number }>;
  gauges: Array<{ name: string; labels: MetricLabels; value: number }>;
} {
  const histograms: Array<{ name: string; labels: MetricLabels; value: number }> = [];
  const gauges: Array<{ name: string; labels: MetricLabels; value: number }> = [];
  return {
    counter: () => undefined,
    gauge(name, labels, value) {
      gauges.push({ name, labels, value });
    },
    histogram(name, labels, value) {
      histograms.push({ name, labels, value });
    },
    histograms,
    gauges,
  };
}

describe('computeDriftPercent', () => {
  it('returns 0 when both are zero', () => {
    expect(computeDriftPercent(0, 0)).toBe(0);
  });
  it('returns +Infinity when local is zero and reported is not', () => {
    expect(computeDriftPercent(0, 5)).toBe(Number.POSITIVE_INFINITY);
  });
  it('returns 0 when counts match', () => {
    expect(computeDriftPercent(100, 100)).toBe(0);
  });
  it('returns positive when reported > local', () => {
    expect(computeDriftPercent(100, 110)).toBe(10);
  });
  it('returns negative when reported < local', () => {
    expect(computeDriftPercent(100, 90)).toBe(-10);
  });
});

describe('TokenAuditService (tiktoken)', () => {
  const tokenizer = createTiktokenProvider();
  tokenizer.preload(['cl100k_base']);
  const sink = createNoopMetricsSink();
  const svc = createTokenAuditService({ tokenizer, metrics: sink });

  it('returns null for an unknown model (skip audit)', () => {
    const r = svc.countPromptTokens('unknown-model', [{ role: 'user', content: 'hi' }]);
    expect(r).toBeNull();
  });

  it('counts a known-string deterministically for cl100k_base', () => {
    // "hello world" is 2 tokens in cl100k_base.
    const r = svc.countCompletionText('model-small', 'hello world');
    expect(r).toBe(2);
  });

  it('sums content across multiple messages for a known model', () => {
    const r = svc.countPromptTokens('model-small', [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hello world' },
    ]);
    expect(r).toBe(4);
  });

  it('emitDrift writes histogram + gauges for both directions', () => {
    const captured = capturingSink();
    const s = createTokenAuditService({ tokenizer, metrics: captured });
    s.emitDrift({
      model: 'model-small',
      nodeId: 'node-a',
      localPromptTokens: 10,
      reportedPromptTokens: 12,
      localCompletionTokens: 20,
      reportedCompletionTokens: 19,
    });
    const histNames = captured.histograms.map((h) => h.name);
    expect(histNames.filter((n) => n === 'tokens_drift_percent')).toHaveLength(2);
    const directions = captured.histograms.map((h) => h.labels.direction);
    expect(directions).toContain('prompt');
    expect(directions).toContain('completion');
    // Gauges: 2 metrics × 2 directions = 4.
    expect(captured.gauges).toHaveLength(4);
  });
});
