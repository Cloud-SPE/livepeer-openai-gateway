// Interface contract test for Recorder. Confirms NoopRecorder, PrometheusRecorder
// and CounterRecorder all satisfy the Recorder interface and exercise the full
// surface without throwing. The compile step alone catches missing methods —
// this test catches typos in label-value constants and obvious wiring errors.

import { describe, expect, it } from 'vitest';
import { NoopRecorder } from './noop.js';
import { PrometheusRecorder } from './prometheus.js';
import {
  NODE_STATE_CIRCUIT_BROKEN,
  NODE_STATE_DEGRADED,
  NODE_STATE_DISABLED,
  NODE_STATE_HEALTHY,
  OUTCOME_2XX,
  OUTCOME_402,
  OUTCOME_429,
  OUTCOME_4XX,
  OUTCOME_5XX,
  OUTCOME_ERROR,
  OUTCOME_OK,
  PAYER_DAEMON_CLOSE_SESSION,
  PAYER_DAEMON_CREATE_PAYMENT,
  PAYER_DAEMON_GET_DEPOSIT_INFO,
  PAYER_DAEMON_START_SESSION,
  RATE_LIMIT_CONCURRENT,
  RATE_LIMIT_RPD,
  RATE_LIMIT_RPM,
  type Recorder,
  RETRY_5XX,
  RETRY_CIRCUIT_OPEN,
  RETRY_QUOTE_EXPIRED,
  RETRY_TIMEOUT,
  TOKEN_DIRECTION_COMPLETION,
  TOKEN_DIRECTION_PROMPT,
} from './recorder.js';
import { CounterRecorder } from './testhelpers.js';

function exercise(r: Recorder): void {
  // Request lifecycle — every outcome bucket.
  for (const out of [OUTCOME_2XX, OUTCOME_4XX, OUTCOME_402, OUTCOME_429, OUTCOME_5XX] as const) {
    r.incRequest('chat.completions', 'gpt-4', 'pro', out);
    r.observeRequest('chat.completions', 'gpt-4', 'pro', out, 0.123);
  }

  // Rate-limit kinds.
  for (const k of [RATE_LIMIT_RPM, RATE_LIMIT_RPD, RATE_LIMIT_CONCURRENT] as const) {
    r.incRateLimitRejection('pro', k);
  }

  // Retry reasons + attempts.
  for (const reason of [
    RETRY_TIMEOUT,
    RETRY_5XX,
    RETRY_QUOTE_EXPIRED,
    RETRY_CIRCUIT_OPEN,
  ] as const) {
    for (const a of ['1', '2', '3'] as const) {
      r.incNodeRetry(reason, a);
    }
  }

  // Money / ledger.
  r.addRevenueUsdCents('chat.completions', 'gpt-4', 'pro', 250);
  r.addNodeCostWei('chat.completions', 'gpt-4', 'node-a', '1000000000');
  r.incTopup(OUTCOME_OK);
  r.incTopup(OUTCOME_ERROR);
  r.setReservationsOpen(7);
  r.setReservationOpenOldestSeconds(42);

  // Stripe.
  r.incStripeWebhook('checkout.session.completed', OUTCOME_OK);
  r.observeStripeWebhook('checkout.session.completed', 0.05);
  r.incStripeApiCall('payment_intent.create', OUTCOME_OK);
  r.observeStripeApiCall('payment_intent.create', 0.18);

  // Nodes.
  for (const s of [
    NODE_STATE_HEALTHY,
    NODE_STATE_DEGRADED,
    NODE_STATE_CIRCUIT_BROKEN,
    NODE_STATE_DISABLED,
  ] as const) {
    r.setNodesState(s, 3);
  }
  r.incNodeRequest('node-a', OUTCOME_2XX);
  r.observeNodeRequest('node-a', OUTCOME_2XX, 0.4);
  r.setNodeQuoteAgeSeconds('node-a', 'chat.completions', 9);
  r.incNodeCircuitTransition('node-a', NODE_STATE_CIRCUIT_BROKEN);

  // PayerDaemon.
  for (const m of [
    PAYER_DAEMON_START_SESSION,
    PAYER_DAEMON_CREATE_PAYMENT,
    PAYER_DAEMON_CLOSE_SESSION,
    PAYER_DAEMON_GET_DEPOSIT_INFO,
  ] as const) {
    r.incPayerDaemonCall(m, OUTCOME_OK);
    r.observePayerDaemonCall(m, 0.0005);
  }
  r.setPayerDaemonDepositWei('5000000000000000');
  r.setPayerDaemonReserveWei('1000000000000000');

  // Token audit.
  for (const dir of [TOKEN_DIRECTION_PROMPT, TOKEN_DIRECTION_COMPLETION] as const) {
    r.observeTokenDriftPercent('node-a', 'gpt-4', dir, -2.5);
    r.addTokenCountLocal('node-a', 'gpt-4', dir, 100);
    r.addTokenCountReported('node-a', 'gpt-4', dir, 102);
  }

  // Build info.
  r.setBuildInfo('1.0.0', 'production', 'v20.10.0');
  r.setShellBuildInfo('1.0.0', 'production', 'v20.10.0');
}

describe('Recorder contract', () => {
  it('NoopRecorder accepts the full surface without throwing', async () => {
    const r = new NoopRecorder();
    exercise(r);
    expect(r.metricsContentType()).toMatch(/text\/plain/);
    expect(await r.metricsText()).toContain('metrics listener not enabled');
  });

  it('CounterRecorder counts each invocation', async () => {
    const c = new CounterRecorder();
    exercise(c);
    expect(c.requests).toBe(5);
    expect(c.requestObservations).toBe(5);
    expect(c.rateLimitRejections).toBe(3);
    expect(c.nodeRetries).toBe(12);
    expect(c.topups).toBe(2);
    expect(c.payerDaemonCalls).toBe(4);
    expect(c.payerDaemonCallObservations).toBe(4);
    expect(c.tokenDriftObservations).toBe(2);
    expect(c.lastRequestOutcome).toBe(OUTCOME_5XX);
    expect(c.lastNodeState).toBe(NODE_STATE_DISABLED);
    expect(c.buildInfoSets).toBe(1);
    expect(await c.metricsText()).toContain('counter recorder');
  });

  it('PrometheusRecorder accepts the full surface and renders metrics', async () => {
    const r = new PrometheusRecorder({ maxSeriesPerMetric: 0 });
    exercise(r);
    const text = await r.metricsText();
    expect(text).toContain('livepeer_bridge_requests_total');
    expect(text).toContain('livepeer_bridge_payer_daemon_calls_total');
    expect(text).toContain('livepeer_bridge_engine_build_info');
    expect(text).toContain('cloudspe_app_build_info');
  });
});
