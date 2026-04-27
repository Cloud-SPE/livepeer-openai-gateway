// Recorder is the fat, domain-specific metrics surface for the bridge. Mirrors
// the philosophy of livepeer-service-registry's Go Recorder: methods are named
// per-emission (incRequest, observeRequest, setReservationsOpen, ...) so a typo
// fails to compile and the catalog of emissions is greppable.
//
// Two implementations live next to this file:
//   - PrometheusRecorder (production): writes to a private prom-client Registry,
//     enforces a per-metric cardinality cap, exposes the standard /metrics
//     exposition body via metricsText().
//   - NoopRecorder (default when METRICS_LISTEN is unset): zero-cost no-op;
//     metricsText() returns a placeholder body and the HTTP server returns 404.
//
// Coexistence note: the existing low-level `MetricsSink` interface in
// ../metrics.ts is preserved unchanged for src/service/tokenAudit. Both
// implementations of Recorder ALSO implement MetricsSink so a single
// instance can replace the noop sink in production. Phase 2 will migrate
// tokenAudit to call the new prefixed methods (observeTokenDriftPercent,
// addTokenCountLocal, addTokenCountReported) and delete MetricsSink.

// ----- Label-value constants -----
//
// The string literals below are the only acceptable values for the
// corresponding labels. Use these constants at call sites instead of bare
// strings so a typo fails to compile and Grafana panels stay stable.

// Outcome buckets for request lifecycle and similar HTTP-shaped emissions.
export const OUTCOME_2XX = '2xx';
export const OUTCOME_4XX = '4xx';
export const OUTCOME_402 = '402';
export const OUTCOME_429 = '429';
export const OUTCOME_5XX = '5xx';
export type RequestOutcome =
  | typeof OUTCOME_2XX
  | typeof OUTCOME_4XX
  | typeof OUTCOME_402
  | typeof OUTCOME_429
  | typeof OUTCOME_5XX;

// Generic ok/error outcome for webhook + API call style emissions.
export const OUTCOME_OK = 'ok';
export const OUTCOME_ERROR = 'error';
export type OkErrorOutcome = typeof OUTCOME_OK | typeof OUTCOME_ERROR;

// Rate-limit kinds. rpm = requests/min, rpd = requests/day, concurrent = inflight cap.
export const RATE_LIMIT_RPM = 'rpm';
export const RATE_LIMIT_RPD = 'rpd';
export const RATE_LIMIT_CONCURRENT = 'concurrent';
export type RateLimitKind =
  | typeof RATE_LIMIT_RPM
  | typeof RATE_LIMIT_RPD
  | typeof RATE_LIMIT_CONCURRENT;

// Retry reasons.
export const RETRY_TIMEOUT = 'timeout';
export const RETRY_5XX = '5xx';
export const RETRY_QUOTE_EXPIRED = 'quote_expired';
export const RETRY_CIRCUIT_OPEN = 'circuit_open';
export type RetryReason =
  | typeof RETRY_TIMEOUT
  | typeof RETRY_5XX
  | typeof RETRY_QUOTE_EXPIRED
  | typeof RETRY_CIRCUIT_OPEN;

// Retry attempt is bounded {1,2,3}. Encoded as a string label.
export type RetryAttempt = '1' | '2' | '3';

// Node states. circuit_broken = circuit breaker is open.
export const NODE_STATE_HEALTHY = 'healthy';
export const NODE_STATE_DEGRADED = 'degraded';
export const NODE_STATE_CIRCUIT_BROKEN = 'circuit_broken';
export const NODE_STATE_DISABLED = 'disabled';
export type NodeState =
  | typeof NODE_STATE_HEALTHY
  | typeof NODE_STATE_DEGRADED
  | typeof NODE_STATE_CIRCUIT_BROKEN
  | typeof NODE_STATE_DISABLED;

// PayerDaemon RPC method names. Matches the gRPC unary method names exactly.
export const PAYER_DAEMON_START_SESSION = 'StartSession';
export const PAYER_DAEMON_CREATE_PAYMENT = 'CreatePayment';
export const PAYER_DAEMON_CLOSE_SESSION = 'CloseSession';
export const PAYER_DAEMON_GET_DEPOSIT_INFO = 'GetDepositInfo';
export type PayerDaemonMethod =
  | typeof PAYER_DAEMON_START_SESSION
  | typeof PAYER_DAEMON_CREATE_PAYMENT
  | typeof PAYER_DAEMON_CLOSE_SESSION
  | typeof PAYER_DAEMON_GET_DEPOSIT_INFO;

// Token-audit direction.
export const TOKEN_DIRECTION_PROMPT = 'prompt';
export const TOKEN_DIRECTION_COMPLETION = 'completion';
export type TokenDirection = typeof TOKEN_DIRECTION_PROMPT | typeof TOKEN_DIRECTION_COMPLETION;

// Sentinel for empty label values. Mirrors Go's LabelUnset. prom-client accepts
// empty strings but they read poorly in Grafana.
export const LABEL_UNSET = '_unset_';

// ----- Recorder interface -----

/**
 * Recorder is the bridge's domain-specific metrics surface. New emissions add
 * a method here and wire it in every implementation (Prometheus, Noop,
 * Counter test helper). Method names follow the convention:
 *   - inc...   (counter)
 *   - observe... (histogram)
 *   - add...   (counter, but accumulating arbitrary deltas — e.g. cents, wei)
 *   - set...   (gauge)
 *
 * Wei amounts are passed as strings because JavaScript's number cannot
 * represent wei without precision loss. Implementations are free to parse
 * them via `BigInt(...)` and then downcast to `number` for Prometheus
 * histogram/gauge observation; that downcast loses precision below the wei
 * level but is acceptable for trend-monitoring metrics. Anything that needs
 * exact accounting goes through the database, not this interface.
 */
export interface Recorder {
  // ----- Request lifecycle -----

  /** Counts one completed inbound request. */
  incRequest(capability: string, model: string, tier: string, outcome: RequestOutcome): void;
  /** Records the end-to-end inbound request latency, in seconds. */
  observeRequest(
    capability: string,
    model: string,
    tier: string,
    outcome: RequestOutcome,
    durationSec: number,
  ): void;

  // ----- Rate limit -----

  /** Counts one rejection by the rate limiter, labeled by tier and which limit fired. */
  incRateLimitRejection(tier: string, kind: RateLimitKind): void;

  // ----- Retries -----

  /** Counts one node-level retry attempt. attempt is bounded {1,2,3}. */
  incNodeRetry(reason: RetryReason, attempt: RetryAttempt): void;

  // ----- Money / ledger -----

  /** Adds revenue to the running counter, in USD cents (integer). */
  addRevenueUsdCents(capability: string, model: string, tier: string, cents: number): void;
  /** Adds node cost in wei. weiAsString avoids precision loss in transit. */
  addNodeCostWei(capability: string, model: string, nodeId: string, weiAsString: string): void;
  /** Counts one Stripe top-up attempt by outcome. */
  incTopup(outcome: OkErrorOutcome): void;
  /** Sets the current count of open reservations. */
  setReservationsOpen(n: number): void;
  /** Sets the age (seconds) of the oldest open reservation. */
  setReservationOpenOldestSeconds(s: number): void;

  // ----- Stripe -----

  /** Counts one Stripe webhook delivery, by event type and outcome. */
  incStripeWebhook(eventType: string, outcome: OkErrorOutcome): void;
  /** Records the duration of a Stripe webhook handler, in seconds. */
  observeStripeWebhook(eventType: string, durationSec: number): void;
  /** Counts one outbound Stripe API call, by op name and outcome. */
  incStripeApiCall(op: string, outcome: OkErrorOutcome): void;
  /** Records the duration of an outbound Stripe API call, in seconds. */
  observeStripeApiCall(op: string, durationSec: number): void;

  // ----- Nodes -----

  /** Sets the current count of nodes in a given state. */
  setNodesState(state: NodeState, n: number): void;
  /** Counts one outbound request to a worker node, by outcome. */
  incNodeRequest(nodeId: string, outcome: RequestOutcome): void;
  /** Records the duration of a worker-node request, in seconds. */
  observeNodeRequest(nodeId: string, outcome: RequestOutcome, durationSec: number): void;
  /** Sets the age (seconds) of the cached quote for a (node, capability) pair. */
  setNodeQuoteAgeSeconds(nodeId: string, capability: string, s: number): void;
  /** Counts one circuit-breaker transition for a node. */
  incNodeCircuitTransition(nodeId: string, toState: NodeState): void;

  // ----- PayerDaemon RPC -----
  //
  // observePayerDaemonCall is dual-histogram: writes to BOTH the standard
  // `_seconds` histogram (default Prometheus buckets) and the sub-ms
  // `_seconds_fast` histogram, because the daemon talks over a unix socket
  // and the cached-quote fast path returns in tens of microseconds — outside
  // the resolution of the default buckets.

  /** Counts one PayerDaemon RPC by method and outcome. */
  incPayerDaemonCall(method: PayerDaemonMethod, outcome: OkErrorOutcome): void;
  /** Records PayerDaemon RPC duration, in seconds. Writes to both histograms. */
  observePayerDaemonCall(method: PayerDaemonMethod, durationSec: number): void;
  /** Sets the current PayerDaemon deposit, in wei (string for precision). */
  setPayerDaemonDepositWei(weiAsString: string): void;
  /** Sets the current PayerDaemon reserve, in wei (string for precision). */
  setPayerDaemonReserveWei(weiAsString: string): void;

  // ----- Token audit (new prefixed names) -----
  //
  // These mirror the legacy unprefixed names emitted by tokenAudit through
  // MetricsSink (`tokens_drift_percent`, `tokens_local_count`,
  // `tokens_reported_count`). They are exposed under the `livepeer_bridge_`
  // namespace so dashboards can migrate. Phase 2 deletes the legacy emissions.

  /** Records the local-vs-reported token drift percent. */
  observeTokenDriftPercent(
    nodeId: string,
    model: string,
    direction: TokenDirection,
    percent: number,
  ): void;
  /** Adds n locally-counted tokens to the running counter. */
  addTokenCountLocal(nodeId: string, model: string, direction: TokenDirection, n: number): void;
  /** Adds n node-reported tokens to the running counter. */
  addTokenCountReported(nodeId: string, model: string, direction: TokenDirection, n: number): void;

  // ----- Build info -----

  /**
   * Sets a constant-1 gauge labeled with engine build metadata
   * (livepeer_bridge_engine_build_info).
   */
  setBuildInfo(version: string, nodeEnv: string, nodeVersion: string): void;

  /**
   * Sets a constant-1 gauge labeled with shell build metadata
   * (cloudspe_app_build_info). Only the shell composition root is
   * expected to call this; engine code emits via setBuildInfo.
   */
  setShellBuildInfo(version: string, nodeEnv: string, nodeVersion: string): void;

  // ----- Exposition -----

  /** The HTTP Content-Type header for the metrics body. */
  metricsContentType(): string;
  /** The Prometheus exposition body. May be a placeholder for the noop impl. */
  metricsText(): Promise<string>;
}
