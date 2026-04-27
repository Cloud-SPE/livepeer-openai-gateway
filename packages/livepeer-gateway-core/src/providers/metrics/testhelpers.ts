// CounterRecorder is a tiny, test-only Recorder + MetricsSink implementation
// that counts each method invocation. Other packages reuse it instead of
// redefining a stub for each test.
//
// Mirrors livepeer-service-registry's metrics.Counter test helper. Counts are
// readonly fields so assertions are as simple as `expect(c.requests).toBe(1)`.

/* eslint-disable @typescript-eslint/no-unused-vars -- intentionally-unused
   parameters: each method matches a Recorder/MetricsSink signature but only
   needs to bump a counter. Adding underscore-prefix is the convention but
   tseslint's default config doesn't honor it. */

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

export class CounterRecorder implements Recorder, MetricsSink {
  // Recorder method counts
  requests = 0;
  requestObservations = 0;
  rateLimitRejections = 0;
  nodeRetries = 0;
  revenueAdds = 0;
  nodeCostAdds = 0;
  topups = 0;
  reservationsOpenSets = 0;
  reservationOldestSets = 0;
  stripeWebhooks = 0;
  stripeWebhookObservations = 0;
  stripeApiCalls = 0;
  stripeApiCallObservations = 0;
  nodesStateSets = 0;
  nodeRequests = 0;
  nodeRequestObservations = 0;
  nodeQuoteAgeSets = 0;
  nodeCircuitTransitions = 0;
  payerDaemonCalls = 0;
  payerDaemonCallObservations = 0;
  payerDaemonDepositSets = 0;
  payerDaemonReserveSets = 0;
  tokenDriftObservations = 0;
  tokenLocalAdds = 0;
  tokenReportedAdds = 0;
  buildInfoSets = 0;
  metricsTextCalls = 0;

  // MetricsSink method counts
  legacyCounters = 0;
  legacyGauges = 0;
  legacyHistograms = 0;

  // Last-set label snapshots for assertion convenience.
  lastRequestOutcome: RequestOutcome | null = null;
  lastNodeState: NodeState | null = null;

  // ----- Recorder -----

  incRequest(_capability: string, _model: string, _tier: string, outcome: RequestOutcome): void {
    this.requests += 1;
    this.lastRequestOutcome = outcome;
  }
  observeRequest(
    _capability: string,
    _model: string,
    _tier: string,
    _outcome: RequestOutcome,
    _durationSec: number,
  ): void {
    this.requestObservations += 1;
  }

  incRateLimitRejection(_tier: string, _kind: RateLimitKind): void {
    this.rateLimitRejections += 1;
  }

  incNodeRetry(_reason: RetryReason, _attempt: RetryAttempt): void {
    this.nodeRetries += 1;
  }

  addRevenueUsdCents(_capability: string, _model: string, _tier: string, _cents: number): void {
    this.revenueAdds += 1;
  }
  addNodeCostWei(
    _capability: string,
    _model: string,
    _nodeId: string,
    _weiAsString: string,
  ): void {
    this.nodeCostAdds += 1;
  }
  incTopup(_outcome: OkErrorOutcome): void {
    this.topups += 1;
  }
  setReservationsOpen(_n: number): void {
    this.reservationsOpenSets += 1;
  }
  setReservationOpenOldestSeconds(_s: number): void {
    this.reservationOldestSets += 1;
  }

  incStripeWebhook(_eventType: string, _outcome: OkErrorOutcome): void {
    this.stripeWebhooks += 1;
  }
  observeStripeWebhook(_eventType: string, _durationSec: number): void {
    this.stripeWebhookObservations += 1;
  }
  incStripeApiCall(_op: string, _outcome: OkErrorOutcome): void {
    this.stripeApiCalls += 1;
  }
  observeStripeApiCall(_op: string, _durationSec: number): void {
    this.stripeApiCallObservations += 1;
  }

  setNodesState(state: NodeState, _n: number): void {
    this.nodesStateSets += 1;
    this.lastNodeState = state;
  }
  incNodeRequest(_nodeId: string, _outcome: RequestOutcome): void {
    this.nodeRequests += 1;
  }
  observeNodeRequest(_nodeId: string, _outcome: RequestOutcome, _durationSec: number): void {
    this.nodeRequestObservations += 1;
  }
  setNodeQuoteAgeSeconds(_nodeId: string, _capability: string, _s: number): void {
    this.nodeQuoteAgeSets += 1;
  }
  incNodeCircuitTransition(_nodeId: string, _toState: NodeState): void {
    this.nodeCircuitTransitions += 1;
  }

  incPayerDaemonCall(_method: PayerDaemonMethod, _outcome: OkErrorOutcome): void {
    this.payerDaemonCalls += 1;
  }
  observePayerDaemonCall(_method: PayerDaemonMethod, _durationSec: number): void {
    this.payerDaemonCallObservations += 1;
  }
  setPayerDaemonDepositWei(_weiAsString: string): void {
    this.payerDaemonDepositSets += 1;
  }
  setPayerDaemonReserveWei(_weiAsString: string): void {
    this.payerDaemonReserveSets += 1;
  }

  observeTokenDriftPercent(
    _nodeId: string,
    _model: string,
    _direction: TokenDirection,
    _percent: number,
  ): void {
    this.tokenDriftObservations += 1;
  }
  addTokenCountLocal(
    _nodeId: string,
    _model: string,
    _direction: TokenDirection,
    _n: number,
  ): void {
    this.tokenLocalAdds += 1;
  }
  addTokenCountReported(
    _nodeId: string,
    _model: string,
    _direction: TokenDirection,
    _n: number,
  ): void {
    this.tokenReportedAdds += 1;
  }

  setBuildInfo(_version: string, _nodeEnv: string, _nodeVersion: string): void {
    this.buildInfoSets += 1;
  }

  setShellBuildInfo(_version: string, _nodeEnv: string, _nodeVersion: string): void {
    this.shellBuildInfoSets += 1;
  }
  shellBuildInfoSets = 0;

  metricsContentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
  async metricsText(): Promise<string> {
    this.metricsTextCalls += 1;
    return '# counter recorder\n';
  }

  // ----- MetricsSink -----

  counter(_name: string, _labels: MetricLabels, _delta?: number): void {
    this.legacyCounters += 1;
  }
  gauge(_name: string, _labels: MetricLabels, _value: number): void {
    this.legacyGauges += 1;
  }
  histogram(_name: string, _labels: MetricLabels, _value: number): void {
    this.legacyHistograms += 1;
  }
}
