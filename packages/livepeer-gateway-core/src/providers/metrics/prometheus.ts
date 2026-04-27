// PrometheusRecorder is the production implementation of Recorder. It owns a
// private prom-client Registry (NOT the global default registry), so consumer
// libraries that register against the default registry don't pollute our
// /metrics output. Built-in process_*/nodejs_* collectors are wired against
// the same private registry via `collectDefaultMetrics({ register })`.
//
// Cardinality cap: every counter/gauge/histogram vec with operator-set label
// values (nodeId, model, eventType, ...) is wrapped in a CapVec that tracks
// the set of seen label tuples. Once `maxSeriesPerMetric` is reached, new
// tuples are silently dropped (existing tuples keep updating) and the
// onCapExceeded callback fires exactly once per metric. Set the cap to 0 to
// disable.
//
// PrometheusRecorder also implements the legacy MetricsSink interface so a
// single instance can serve both the new domain-specific Recorder methods
// (`incRequest`, ...) and the existing tokenAudit emissions
// (`metrics.histogram('tokens_drift_percent', ...)`). Phase 2 unifies them.

import type {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
} from 'prom-client';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import type { MetricLabels, MetricsSink } from '../metrics.js';
import { CapVec } from './capVec.js';
import { LegacySink } from './legacySink.js';
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
import { LABEL_UNSET } from './recorder.js';

/** Construction parameters for PrometheusRecorder. */
export interface PrometheusConfig {
  /**
   * Hard cap on distinct label tuples any single metric may track. New
   * combinations beyond the cap are silently dropped. 0 disables the cap.
   */
  readonly maxSeriesPerMetric: number;

  /**
   * Invoked once per exceeded metric (deduped). Operators wire this to a
   * structured logger so the violation is loud in the daemon log.
   */
  readonly onCapExceeded?: (metricName: string, observed: number, cap: number) => void;
}

/**
 * Metric prefix for engine-emitted metrics. Mirrors `livepeer_registry_`
 * in the Go reference; engine consumers (request lifecycle, node-pool
 * state, payer-daemon, rate-limit) all live under this prefix.
 */
const NS = 'livepeer_bridge';

/**
 * Metric prefix for shell-emitted metrics (Stripe API/webhooks, top-ups,
 * shell build_info). Set by exec-plan 0026 step 9; rename if the Cloud
 * SPE product takes a different brand.
 */
const SHELL_NS = 'cloudspe';

/** Default histogram buckets — match prom-client's default. */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** Sub-millisecond buckets for the unix-socket fast path. */
const FAST_BUCKETS = [
  0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1,
] as const;

/** unset replaces empty string label values with the LABEL_UNSET sentinel. */
function unset(v: string): string {
  return v === '' ? LABEL_UNSET : v;
}

/**
 * weiToFloat parses a wei string and downcasts to a Number. Loses precision
 * below the wei level (Number has 53 bits of mantissa; 1 ETH = 1e18 wei, so
 * Number can represent up to ~9e15 wei exactly, ~9000 ETH). Acceptable for
 * trend monitoring; exact accounting goes through the database.
 */
function weiToFloat(weiAsString: string): number {
  if (!weiAsString) return 0;
  try {
    return Number(BigInt(weiAsString));
  } catch {
    // Fall back to Number() for decimals or malformed input.
    const n = Number(weiAsString);
    return Number.isFinite(n) ? n : 0;
  }
}

export class PrometheusRecorder implements Recorder, MetricsSink {
  readonly registry: Registry;
  private readonly legacy: LegacySink;

  // ----- Request lifecycle -----
  private readonly requestsTotal: CapVec<PromCounter<string>>;
  private readonly requestDuration: CapVec<PromHistogram<string>>;

  // ----- Rate limit -----
  private readonly rateLimitRejections: CapVec<PromCounter<string>>;

  // ----- Retries -----
  private readonly nodeRetries: CapVec<PromCounter<string>>;

  // ----- Money / ledger -----
  private readonly revenueUsdCents: CapVec<PromCounter<string>>;
  private readonly nodeCostWei: CapVec<PromCounter<string>>;
  private readonly topups: CapVec<PromCounter<string>>;
  private readonly reservationsOpen: PromGauge<string>;
  private readonly reservationOldestSec: PromGauge<string>;

  // ----- Stripe -----
  private readonly stripeWebhooks: CapVec<PromCounter<string>>;
  private readonly stripeWebhookDuration: CapVec<PromHistogram<string>>;
  private readonly stripeApiCalls: CapVec<PromCounter<string>>;
  private readonly stripeApiCallDuration: CapVec<PromHistogram<string>>;

  // ----- Nodes -----
  private readonly nodesState: CapVec<PromGauge<string>>;
  private readonly nodeRequests: CapVec<PromCounter<string>>;
  private readonly nodeRequestDuration: CapVec<PromHistogram<string>>;
  private readonly nodeQuoteAgeSec: CapVec<PromGauge<string>>;
  private readonly nodeCircuitTransitions: CapVec<PromCounter<string>>;

  // ----- PayerDaemon RPC -----
  private readonly payerDaemonCalls: CapVec<PromCounter<string>>;
  private readonly payerDaemonCallDuration: CapVec<PromHistogram<string>>;
  private readonly payerDaemonCallDurationFast: CapVec<PromHistogram<string>>;
  private readonly payerDaemonDepositWei: PromGauge<string>;
  private readonly payerDaemonReserveWei: PromGauge<string>;

  // ----- Token audit (prefixed) -----
  private readonly tokenDriftPercent: CapVec<PromHistogram<string>>;
  private readonly tokenCountLocal: CapVec<PromCounter<string>>;
  private readonly tokenCountReported: CapVec<PromCounter<string>>;

  // ----- Build info -----
  private readonly buildInfo: PromGauge<string>;
  private readonly shellBuildInfo: PromGauge<string>;

  constructor(cfg: PrometheusConfig) {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });
    this.legacy = new LegacySink(this.registry);

    const onExceed = cfg.onCapExceeded;
    const cap = cfg.maxSeriesPerMetric;
    const reg = this.registry;

    // Helpers for the four kinds of vec.
    const counterVec = (name: string, help: string, labels: string[]) =>
      new CapVec(
        name,
        new Counter({ name: `${NS}_${name}`, help, labelNames: labels, registers: [reg] }),
        cap,
        onExceed,
      );
    const gaugeVec = (name: string, help: string, labels: string[]) =>
      new CapVec(
        name,
        new Gauge({ name: `${NS}_${name}`, help, labelNames: labels, registers: [reg] }),
        cap,
        onExceed,
      );
    const histVec = (
      name: string,
      help: string,
      labels: string[],
      buckets: readonly number[] = DEFAULT_BUCKETS,
    ) =>
      new CapVec(
        name,
        new Histogram({
          name: `${NS}_${name}`,
          help,
          labelNames: labels,
          buckets: [...buckets],
          registers: [reg],
        }),
        cap,
        onExceed,
      );

    // Shell-prefixed helper variants for metrics emitted by shell-side
    // code paths (Stripe, top-ups, reservations). Per exec-plan 0026
    // step 9: engine = livepeer_bridge_*, shell = cloudspe_*.
    const shellCounterVec = (name: string, help: string, labels: string[]) =>
      new CapVec(
        name,
        new Counter({
          name: `${SHELL_NS}_${name}`,
          help,
          labelNames: labels,
          registers: [reg],
        }),
        cap,
        onExceed,
      );
    const shellHistVec = (
      name: string,
      help: string,
      labels: string[],
      buckets: readonly number[] = DEFAULT_BUCKETS,
    ) =>
      new CapVec(
        name,
        new Histogram({
          name: `${SHELL_NS}_${name}`,
          help,
          labelNames: labels,
          buckets: [...buckets],
          registers: [reg],
        }),
        cap,
        onExceed,
      );

    // ----- Request lifecycle -----
    this.requestsTotal = counterVec(
      'requests_total',
      'Total inbound requests served, labeled by capability/model/tier/outcome.',
      ['capability', 'model', 'tier', 'outcome'],
    );
    this.requestDuration = histVec(
      'request_duration_seconds',
      'End-to-end inbound request latency, labeled by capability/model/tier/outcome.',
      ['capability', 'model', 'tier', 'outcome'],
    );

    // ----- Rate limit -----
    this.rateLimitRejections = counterVec(
      'rate_limit_rejections_total',
      'Rejections from the rate limiter, labeled by tier and which limit fired.',
      ['tier', 'kind'],
    );

    // ----- Retries -----
    this.nodeRetries = counterVec(
      'node_retries_total',
      'Node-level retry attempts, labeled by reason and attempt number (1..3).',
      ['reason', 'attempt'],
    );

    // ----- Money / ledger -----
    this.revenueUsdCents = counterVec(
      'revenue_usd_cents_total',
      'Total revenue in USD cents, labeled by capability/model/tier.',
      ['capability', 'model', 'tier'],
    );
    this.nodeCostWei = counterVec(
      'node_cost_wei_total',
      'Total cost paid to nodes in wei, labeled by capability/model/node_id.',
      ['capability', 'model', 'node_id'],
    );
    // ----- Money / ledger (shell-emitted) -----
    this.topups = shellCounterVec(
      'topups_total',
      'Stripe top-up attempts, labeled by outcome.',
      ['outcome'],
    );
    this.reservationsOpen = new Gauge({
      name: `${SHELL_NS}_reservations_open`,
      help: 'Current count of open reservations.',
      registers: [reg],
    });
    this.reservationOldestSec = new Gauge({
      name: `${SHELL_NS}_reservation_open_oldest_seconds`,
      help: 'Age in seconds of the oldest currently-open reservation.',
      registers: [reg],
    });

    // ----- Stripe (shell-emitted) -----
    this.stripeWebhooks = shellCounterVec(
      'stripe_webhooks_total',
      'Stripe webhook deliveries, labeled by event type and outcome.',
      ['event_type', 'outcome'],
    );
    this.stripeWebhookDuration = shellHistVec(
      'stripe_webhook_duration_seconds',
      'Stripe webhook handler duration in seconds, labeled by event type.',
      ['event_type'],
    );
    this.stripeApiCalls = shellCounterVec(
      'stripe_api_calls_total',
      'Outbound Stripe API calls, labeled by op and outcome.',
      ['op', 'outcome'],
    );
    this.stripeApiCallDuration = histVec(
      'stripe_api_call_duration_seconds',
      'Outbound Stripe API call duration in seconds, labeled by op.',
      ['op'],
    );

    // ----- Nodes -----
    this.nodesState = gaugeVec('nodes_state', 'Current count of nodes in each state.', ['state']);
    this.nodeRequests = counterVec(
      'node_requests_total',
      'Outbound worker-node requests, labeled by node_id and outcome.',
      ['node_id', 'outcome'],
    );
    this.nodeRequestDuration = histVec(
      'node_request_duration_seconds',
      'Worker-node request duration in seconds, labeled by node_id and outcome.',
      ['node_id', 'outcome'],
    );
    this.nodeQuoteAgeSec = gaugeVec(
      'node_quote_age_seconds',
      'Age in seconds of the cached quote per (node, capability).',
      ['node_id', 'capability'],
    );
    this.nodeCircuitTransitions = counterVec(
      'node_circuit_transitions_total',
      'Circuit-breaker state transitions per node.',
      ['node_id', 'to_state'],
    );

    // ----- PayerDaemon RPC -----
    this.payerDaemonCalls = counterVec(
      'payer_daemon_calls_total',
      'PayerDaemon RPC calls, labeled by method and outcome.',
      ['method', 'outcome'],
    );
    this.payerDaemonCallDuration = histVec(
      'payer_daemon_call_duration_seconds',
      'PayerDaemon RPC duration in seconds (default Prometheus buckets).',
      ['method'],
    );
    this.payerDaemonCallDurationFast = histVec(
      'payer_daemon_call_duration_seconds_fast',
      'PayerDaemon RPC duration in seconds, sub-ms buckets for the unix-socket fast path.',
      ['method'],
      FAST_BUCKETS,
    );
    this.payerDaemonDepositWei = new Gauge({
      name: `${NS}_payer_daemon_deposit_wei`,
      help: 'Current PayerDaemon deposit, in wei (Number-cast; precision below ~9e15 wei is exact).',
      registers: [reg],
    });
    this.payerDaemonReserveWei = new Gauge({
      name: `${NS}_payer_daemon_reserve_wei`,
      help: 'Current PayerDaemon reserve, in wei (Number-cast; precision below ~9e15 wei is exact).',
      registers: [reg],
    });

    // ----- Token audit (prefixed) -----
    this.tokenDriftPercent = histVec(
      'token_drift_percent',
      'Local-vs-reported token drift percent, labeled by node/model/direction.',
      ['node_id', 'model', 'direction'],
    );
    this.tokenCountLocal = counterVec(
      'token_count_local_total',
      'Sum of locally-counted tokens, labeled by node/model/direction.',
      ['node_id', 'model', 'direction'],
    );
    this.tokenCountReported = counterVec(
      'token_count_reported_total',
      'Sum of node-reported tokens, labeled by node/model/direction.',
      ['node_id', 'model', 'direction'],
    );

    // ----- Build info -----
    this.buildInfo = new Gauge({
      name: `${NS}_engine_build_info`,
      help: 'Constant-1 gauge labeled with engine build metadata.',
      labelNames: ['version', 'node_env', 'node_version'],
      registers: [reg],
    });
    this.shellBuildInfo = new Gauge({
      name: `${SHELL_NS}_app_build_info`,
      help: 'Constant-1 gauge labeled with shell (gateway app) build metadata.',
      labelNames: ['version', 'node_env', 'node_version'],
      registers: [reg],
    });
  }

  // ----- Recorder: request lifecycle -----

  incRequest(capability: string, model: string, tier: string, outcome: RequestOutcome): void {
    this.requestsTotal.inc(unset(capability), unset(model), unset(tier), outcome);
  }
  observeRequest(
    capability: string,
    model: string,
    tier: string,
    outcome: RequestOutcome,
    durationSec: number,
  ): void {
    this.requestDuration.observe(durationSec, unset(capability), unset(model), unset(tier), outcome);
  }

  // ----- Recorder: rate limit -----

  incRateLimitRejection(tier: string, kind: RateLimitKind): void {
    this.rateLimitRejections.inc(unset(tier), kind);
  }

  // ----- Recorder: retries -----

  incNodeRetry(reason: RetryReason, attempt: RetryAttempt): void {
    this.nodeRetries.inc(reason, attempt);
  }

  // ----- Recorder: money / ledger -----

  addRevenueUsdCents(capability: string, model: string, tier: string, cents: number): void {
    this.revenueUsdCents.add(cents, unset(capability), unset(model), unset(tier));
  }
  addNodeCostWei(capability: string, model: string, nodeId: string, weiAsString: string): void {
    this.nodeCostWei.add(weiToFloat(weiAsString), unset(capability), unset(model), unset(nodeId));
  }
  incTopup(outcome: OkErrorOutcome): void {
    this.topups.inc(outcome);
  }
  setReservationsOpen(n: number): void {
    this.reservationsOpen.set(n);
  }
  setReservationOpenOldestSeconds(s: number): void {
    this.reservationOldestSec.set(s);
  }

  // ----- Recorder: Stripe -----

  incStripeWebhook(eventType: string, outcome: OkErrorOutcome): void {
    this.stripeWebhooks.inc(unset(eventType), outcome);
  }
  observeStripeWebhook(eventType: string, durationSec: number): void {
    this.stripeWebhookDuration.observe(durationSec, unset(eventType));
  }
  incStripeApiCall(op: string, outcome: OkErrorOutcome): void {
    this.stripeApiCalls.inc(unset(op), outcome);
  }
  observeStripeApiCall(op: string, durationSec: number): void {
    this.stripeApiCallDuration.observe(durationSec, unset(op));
  }

  // ----- Recorder: nodes -----

  setNodesState(state: NodeState, n: number): void {
    this.nodesState.set(n, state);
  }
  incNodeRequest(nodeId: string, outcome: RequestOutcome): void {
    this.nodeRequests.inc(unset(nodeId), outcome);
  }
  observeNodeRequest(nodeId: string, outcome: RequestOutcome, durationSec: number): void {
    this.nodeRequestDuration.observe(durationSec, unset(nodeId), outcome);
  }
  setNodeQuoteAgeSeconds(nodeId: string, capability: string, s: number): void {
    this.nodeQuoteAgeSec.set(s, unset(nodeId), unset(capability));
  }
  incNodeCircuitTransition(nodeId: string, toState: NodeState): void {
    this.nodeCircuitTransitions.inc(unset(nodeId), toState);
  }

  // ----- Recorder: PayerDaemon RPC -----

  incPayerDaemonCall(method: PayerDaemonMethod, outcome: OkErrorOutcome): void {
    this.payerDaemonCalls.inc(method, outcome);
  }
  observePayerDaemonCall(method: PayerDaemonMethod, durationSec: number): void {
    this.payerDaemonCallDuration.observe(durationSec, method);
    this.payerDaemonCallDurationFast.observe(durationSec, method);
  }
  setPayerDaemonDepositWei(weiAsString: string): void {
    this.payerDaemonDepositWei.set(weiToFloat(weiAsString));
  }
  setPayerDaemonReserveWei(weiAsString: string): void {
    this.payerDaemonReserveWei.set(weiToFloat(weiAsString));
  }

  // ----- Recorder: token audit (prefixed) -----

  observeTokenDriftPercent(
    nodeId: string,
    model: string,
    direction: TokenDirection,
    percent: number,
  ): void {
    this.tokenDriftPercent.observe(percent, unset(nodeId), unset(model), direction);
  }
  addTokenCountLocal(nodeId: string, model: string, direction: TokenDirection, n: number): void {
    this.tokenCountLocal.add(n, unset(nodeId), unset(model), direction);
  }
  addTokenCountReported(
    nodeId: string,
    model: string,
    direction: TokenDirection,
    n: number,
  ): void {
    this.tokenCountReported.add(n, unset(nodeId), unset(model), direction);
  }

  // ----- Recorder: build info -----

  setBuildInfo(version: string, nodeEnv: string, nodeVersion: string): void {
    this.buildInfo.labels(version, nodeEnv, nodeVersion).set(1);
  }

  setShellBuildInfo(version: string, nodeEnv: string, nodeVersion: string): void {
    this.shellBuildInfo.labels(version, nodeEnv, nodeVersion).set(1);
  }

  // ----- Recorder: exposition -----

  metricsContentType(): string {
    return this.registry.contentType;
  }
  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  // ----- MetricsSink (legacy) -----
  //
  // Phase-1 allowlist only — see legacySink.ts. Anything off the list is dropped.

  counter(name: string, labels: MetricLabels, delta: number = 1): void {
    const labelNames = Object.keys(labels).sort();
    const vec = this.legacy.counter(name, labelNames);
    if (!vec) return;
    vec.labels(...labelNames.map((k) => String(labels[k] ?? ''))).inc(delta);
  }
  gauge(name: string, labels: MetricLabels, value: number): void {
    const labelNames = Object.keys(labels).sort();
    const vec = this.legacy.gauge(name, labelNames);
    if (!vec) return;
    vec.labels(...labelNames.map((k) => String(labels[k] ?? ''))).set(value);
  }
  histogram(name: string, labels: MetricLabels, value: number): void {
    const labelNames = Object.keys(labels).sort();
    const vec = this.legacy.histogram(name, labelNames);
    if (!vec) return;
    vec.labels(...labelNames.map((k) => String(labels[k] ?? ''))).observe(value);
  }
}
