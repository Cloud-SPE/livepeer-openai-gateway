// NoopRecorder is the default Recorder + MetricsSink implementation when the
// metrics listener is unset. Every method returns immediately; metricsText()
// returns a placeholder body. The HTTP server in src/runtime/metrics/server.ts
// returns 404 in that mode anyway, so the placeholder is only reached if the
// caller bypasses the server.

/* eslint-disable @typescript-eslint/no-unused-vars -- intentionally-unused
   parameters: this file is a no-op stub for every Recorder / MetricsSink
   method. The signatures must match the interface so callers compile
   identically against either implementation. */

import type { MetricLabels, MetricsSink } from '../metrics.js';
import type {
  NodeState,
  OkErrorOutcome,
  PayerDaemonMethod,
  RateLimitKind,
  Recorder,
  RequestOutcome,
  RetryAttempt,
  RetryReason,
  TokenDirection,
} from './recorder.js';

export class NoopRecorder implements Recorder, MetricsSink {
  // ----- Recorder -----

  incRequest(_capability: string, _model: string, _tier: string, _outcome: RequestOutcome): void {}
  observeRequest(
    _capability: string,
    _model: string,
    _tier: string,
    _outcome: RequestOutcome,
    _durationSec: number,
  ): void {}

  incRateLimitRejection(_tier: string, _kind: RateLimitKind): void {}

  incNodeRetry(_reason: RetryReason, _attempt: RetryAttempt): void {}

  addRevenueUsdCents(_capability: string, _model: string, _tier: string, _cents: number): void {}
  addNodeCostWei(
    _capability: string,
    _model: string,
    _nodeId: string,
    _weiAsString: string,
  ): void {}
  incTopup(_outcome: OkErrorOutcome): void {}
  setReservationsOpen(_n: number): void {}
  setReservationOpenOldestSeconds(_s: number): void {}

  incStripeWebhook(_eventType: string, _outcome: OkErrorOutcome): void {}
  observeStripeWebhook(_eventType: string, _durationSec: number): void {}
  incStripeApiCall(_op: string, _outcome: OkErrorOutcome): void {}
  observeStripeApiCall(_op: string, _durationSec: number): void {}

  setNodesState(_state: NodeState, _n: number): void {}
  incNodeRequest(_nodeId: string, _outcome: RequestOutcome): void {}
  observeNodeRequest(_nodeId: string, _outcome: RequestOutcome, _durationSec: number): void {}
  setNodeQuoteAgeSeconds(_nodeId: string, _capability: string, _s: number): void {}
  incNodeCircuitTransition(_nodeId: string, _toState: NodeState): void {}

  incPayerDaemonCall(_method: PayerDaemonMethod, _outcome: OkErrorOutcome): void {}
  observePayerDaemonCall(_method: PayerDaemonMethod, _durationSec: number): void {}
  setPayerDaemonDepositWei(_weiAsString: string): void {}
  setPayerDaemonReserveWei(_weiAsString: string): void {}

  observeTokenDriftPercent(
    _nodeId: string,
    _model: string,
    _direction: TokenDirection,
    _percent: number,
  ): void {}
  addTokenCountLocal(
    _nodeId: string,
    _model: string,
    _direction: TokenDirection,
    _n: number,
  ): void {}
  addTokenCountReported(
    _nodeId: string,
    _model: string,
    _direction: TokenDirection,
    _n: number,
  ): void {}

  setBuildInfo(_version: string, _nodeEnv: string, _nodeVersion: string): void {}

  metricsContentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
  async metricsText(): Promise<string> {
    return '# metrics listener not enabled (set METRICS_LISTEN to enable Prometheus output)\n';
  }

  // ----- MetricsSink (legacy) -----

  counter(_name: string, _labels: MetricLabels, _delta?: number): void {}
  gauge(_name: string, _labels: MetricLabels, _value: number): void {}
  histogram(_name: string, _labels: MetricLabels, _value: number): void {}
}

/**
 * Backward-compat factory used by the existing main.ts and tokenAudit tests
 * to obtain a no-op MetricsSink. New code should construct NoopRecorder
 * directly to get both Recorder + MetricsSink in one object.
 */
export function createNoopMetricsSink(): MetricsSink {
  return new NoopRecorder();
}
