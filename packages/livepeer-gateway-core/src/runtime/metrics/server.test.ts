import { describe, expect, it } from 'vitest';
import { NoopRecorder } from '../../providers/metrics/noop.js';
import { PrometheusRecorder } from '../../providers/metrics/prometheus.js';
import { OUTCOME_2XX } from '../../providers/metrics/recorder.js';
import { createMetricsServer } from './server.js';

describe('createMetricsServer', () => {
  it('empty listen returns a no-op server (start/stop/address all safe)', async () => {
    const r = new NoopRecorder();
    const s = createMetricsServer({ listen: '', recorder: r });
    await s.start();
    expect(s.address()).toBeNull();
    await s.stop();
  });

  it('binds and serves /metrics with Prometheus content type and recorder body', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    r.incRequest('chat.completions', 'gpt-4', 'pro', OUTCOME_2XX);

    const s = createMetricsServer({ listen: '127.0.0.1:0', recorder: r });
    await s.start();
    try {
      const addr = s.address();
      expect(addr).not.toBeNull();
      const res = await fetch(`${addr}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toMatch(/text\/plain/);
      const body = await res.text();
      expect(body).toContain('livepeer_bridge_requests_total');
    } finally {
      await s.stop();
    }
  });

  it('serves /healthz with 200 { ok: true }', async () => {
    const r = new NoopRecorder();
    const s = createMetricsServer({ listen: '127.0.0.1:0', recorder: r });
    await s.start();
    try {
      const res = await fetch(`${s.address()}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await s.stop();
    }
  });

  it('stop() shuts down cleanly and address() returns null afterwards', async () => {
    const r = new NoopRecorder();
    const s = createMetricsServer({ listen: '127.0.0.1:0', recorder: r });
    await s.start();
    expect(s.address()).not.toBeNull();
    await s.stop();
    expect(s.address()).toBeNull();
    // Idempotent.
    await s.stop();
  });

  it('rejects malformed listen specs by returning a no-op server', async () => {
    const r = new NoopRecorder();
    const s = createMetricsServer({ listen: 'not-a-port', recorder: r });
    await s.start();
    expect(s.address()).toBeNull();
    await s.stop();
  });
});
