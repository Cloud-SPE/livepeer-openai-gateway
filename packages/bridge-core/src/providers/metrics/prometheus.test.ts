import { describe, expect, it, vi } from 'vitest';
import { register as defaultRegistry } from 'prom-client';
import { PrometheusRecorder } from './prometheus.js';
import {
  OUTCOME_2XX,
  OUTCOME_OK,
  PAYER_DAEMON_START_SESSION,
} from './recorder.js';

describe('PrometheusRecorder', () => {
  it('uses a private registry; default global registry is untouched', async () => {
    const before = await defaultRegistry.metrics();
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.incRequest('chat.completions', 'gpt-4', 'pro', OUTCOME_2XX);
    const after = await defaultRegistry.metrics();
    expect(after).toBe(before);
    expect(after).not.toContain('livepeer_bridge_requests_total');
  });

  it('emit-and-scrape: incRequest produces a counter line in metricsText()', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.incRequest('chat.completions', 'gpt-4', 'pro', OUTCOME_2XX);
    const text = await r.metricsText();
    expect(text).toMatch(/livepeer_bridge_requests_total\{[^}]+\} 1/);
  });

  it('dual-histogram: one observePayerDaemonCall produces both _seconds and _seconds_fast series', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.observePayerDaemonCall(PAYER_DAEMON_START_SESSION, 0.0005);
    const text = await r.metricsText();
    expect(text).toContain('livepeer_bridge_payer_daemon_call_duration_seconds_count');
    expect(text).toContain('livepeer_bridge_payer_daemon_call_duration_seconds_fast_count');
  });

  it('cardinality cap drops new tuples beyond max and fires onCapExceeded once', () => {
    const onCapExceeded = vi.fn();
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 2, onCapExceeded });
    // Fill cap on requests_total.
    r.incRequest('a', 'm1', 'pro', OUTCOME_2XX);
    r.incRequest('a', 'm2', 'pro', OUTCOME_2XX);
    // These two new tuples are dropped — the callback fires once.
    r.incRequest('a', 'm3', 'pro', OUTCOME_2XX);
    r.incRequest('a', 'm4', 'pro', OUTCOME_2XX);
    expect(onCapExceeded).toHaveBeenCalledTimes(1);
    expect(onCapExceeded).toHaveBeenCalledWith('requests_total', 2, 2);
  });

  it('cardinality cap allows existing tuples to keep updating', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 1 });
    r.incRequest('a', 'm1', 'pro', OUTCOME_2XX);
    r.incRequest('a', 'm1', 'pro', OUTCOME_2XX);
    r.incRequest('a', 'm2', 'pro', OUTCOME_2XX); // dropped
    const text = await r.metricsText();
    expect(text).toMatch(/m1[^\n]* 2/);
    expect(text).not.toMatch(/m2/);
  });

  it('legacy MetricsSink emissions land under the unprefixed name in the same registry', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.histogram('tokens_drift_percent', { node_id: 'n1', model: 'm', direction: 'prompt' }, -1.2);
    r.gauge('tokens_local_count', { node_id: 'n1', model: 'm', direction: 'prompt' }, 50);
    const text = await r.metricsText();
    expect(text).toContain('tokens_drift_percent_count');
    expect(text).toContain('tokens_local_count');
  });

  it('legacy MetricsSink drops names outside the Phase-1 allowlist', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.counter('not_allowed_metric', { x: 'y' });
    const text = await r.metricsText();
    expect(text).not.toContain('not_allowed_metric');
  });

  it('incTopup, addRevenueUsdCents, setBuildInfo all surface in metricsText', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.incTopup(OUTCOME_OK);
    r.addRevenueUsdCents('chat.completions', 'gpt-4', 'pro', 1000);
    r.setBuildInfo('1.2.3', 'production', 'v20');
    r.setShellBuildInfo('1.2.3', 'production', 'v20');
    const text = await r.metricsText();
    expect(text).toContain('cloudspe_topups_total');
    expect(text).toContain('livepeer_bridge_revenue_usd_cents_total');
    expect(text).toMatch(/livepeer_bridge_engine_build_info\{[^}]*version="1.2.3"[^}]*\} 1/);
    expect(text).toMatch(/cloudspe_app_build_info\{[^}]*version="1.2.3"[^}]*\} 1/);
  });

  it('default Node.js process_* and nodejs_* collectors register against the private registry', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    const text = await r.metricsText();
    expect(text).toMatch(/process_cpu_user_seconds_total|nodejs_eventloop_lag_seconds/);
  });

  it('handles malformed wei strings without throwing', () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    expect(() => r.setPayerDaemonDepositWei('not-a-number')).not.toThrow();
    expect(() => r.addNodeCostWei('cap', 'm', 'n', '0.5')).not.toThrow();
    expect(() => r.setPayerDaemonReserveWei('')).not.toThrow();
  });
});
