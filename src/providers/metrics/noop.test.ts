import { describe, expect, it } from 'vitest';
import { NoopRecorder, createNoopMetricsSink } from './noop.js';
import {
  NODE_STATE_HEALTHY,
  OUTCOME_2XX,
  OUTCOME_OK,
  PAYER_DAEMON_START_SESSION,
  RATE_LIMIT_RPM,
  RETRY_TIMEOUT,
  TOKEN_DIRECTION_PROMPT,
} from './recorder.js';

describe('NoopRecorder', () => {
  it('every Recorder + MetricsSink method runs without throwing', async () => {
    const r = new NoopRecorder();

    r.incRequest('cap', 'm', 'pro', OUTCOME_2XX);
    r.observeRequest('cap', 'm', 'pro', OUTCOME_2XX, 0.1);
    r.incRateLimitRejection('pro', RATE_LIMIT_RPM);
    r.incNodeRetry(RETRY_TIMEOUT, '1');
    r.addRevenueUsdCents('cap', 'm', 'pro', 100);
    r.addNodeCostWei('cap', 'm', 'n', '1000');
    r.incTopup(OUTCOME_OK);
    r.setReservationsOpen(1);
    r.setReservationOpenOldestSeconds(2);
    r.incStripeWebhook('e', OUTCOME_OK);
    r.observeStripeWebhook('e', 0.1);
    r.incStripeApiCall('op', OUTCOME_OK);
    r.observeStripeApiCall('op', 0.1);
    r.setNodesState(NODE_STATE_HEALTHY, 3);
    r.incNodeRequest('n', OUTCOME_2XX);
    r.observeNodeRequest('n', OUTCOME_2XX, 0.1);
    r.setNodeQuoteAgeSeconds('n', 'cap', 5);
    r.incNodeCircuitTransition('n', NODE_STATE_HEALTHY);
    r.incPayerDaemonCall(PAYER_DAEMON_START_SESSION, OUTCOME_OK);
    r.observePayerDaemonCall(PAYER_DAEMON_START_SESSION, 0.0005);
    r.setPayerDaemonDepositWei('100');
    r.setPayerDaemonReserveWei('100');
    r.observeTokenDriftPercent('n', 'm', TOKEN_DIRECTION_PROMPT, -1);
    r.addTokenCountLocal('n', 'm', TOKEN_DIRECTION_PROMPT, 1);
    r.addTokenCountReported('n', 'm', TOKEN_DIRECTION_PROMPT, 1);
    r.setBuildInfo('v', 'env', 'node');

    r.counter('legacy', { a: 'b' });
    r.gauge('legacy', { a: 'b' }, 1);
    r.histogram('legacy', { a: 'b' }, 1);

    expect(r.metricsContentType()).toMatch(/text\/plain/);
    expect(await r.metricsText()).toContain('not enabled');
  });

  it('createNoopMetricsSink returns a working MetricsSink', () => {
    const sink = createNoopMetricsSink();
    expect(() => sink.counter('x', {})).not.toThrow();
    expect(() => sink.gauge('x', {}, 1)).not.toThrow();
    expect(() => sink.histogram('x', {}, 1)).not.toThrow();
  });
});
