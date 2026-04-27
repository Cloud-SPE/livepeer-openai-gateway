// Periodic sampler for "snapshot" metrics that only make sense if read on a
// timer rather than at the moment of an event. Mirrors the
// service-registry's `internal/service/metrics/sampler.go` shape.
//
// Per tick the sampler:
//   1. SELECTs (count, oldest-age) of `state='open'` reservations and feeds
//      `setReservationsOpen` / `setReservationOpenOldestSeconds`.
//   2. Walks the registry-driven NodeIndex + CircuitBreaker and emits
//      `setNodesState(state, n)` for each of the three live states
//      (healthy, degraded, circuit_broken). There is no "disabled"
//      bucket — the registry-daemon owns membership and only surfaces
//      nodes it considers eligible.
//   3. Reads the cached deposit-info via the supplied DepositInfoSource and
//      sets `setPayerDaemonDepositWei` + `setPayerDaemonReserveWei`. The
//      source is supplied by the composition root so the sampler does NOT
//      issue a fresh RPC — it reads whatever the existing health-loop has
//      already populated.
//
// All db / NodeIndex / DepositInfoSource calls are wrapped in try/catch so a
// single failing source doesn't break the rest of the tick.

import { sql } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import type { CircuitBreaker } from '../routing/circuitBreaker.js';
import type { NodeIndex } from '../routing/nodeIndex.js';
import type { DepositInfo } from '../../providers/payerDaemon.js';
import {
  NODE_STATE_CIRCUIT_BROKEN,
  NODE_STATE_DEGRADED,
  NODE_STATE_HEALTHY,
  type Recorder,
} from '../../providers/metrics/recorder.js';

/**
 * Source for the cached deposit/reserve readings. Returning null means the
 * health-loop has not yet succeeded once — the sampler will skip the gauge
 * update for that tick (the gauges retain their previous value).
 */
export type DepositInfoSource = () => DepositInfo | null;

export interface MetricsSamplerDeps {
  db: Db;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
  depositInfoSource: DepositInfoSource;
  recorder: Recorder;
  intervalMs?: number;
  /** Optional logger hook for diagnostic warnings. Defaults to console.warn. */
  onError?: (where: string, err: unknown) => void;
}

export interface MetricsSampler {
  start(): void;
  stop(): void;
  /** Run a single tick synchronously. Test affordance. */
  tickOnce(): Promise<void>;
}

export function createMetricsSampler(deps: MetricsSamplerDeps): MetricsSampler {
  const intervalMs = deps.intervalMs ?? 30_000;
  const onError =
    deps.onError ??
    ((where: string, err: unknown) => {
      console.warn(`[metrics-sampler] ${where}:`, err);
    });

  let timer: ReturnType<typeof setInterval> | null = null;

  async function sampleReservations(): Promise<void> {
    try {
      // Cross-schema query into app.reservations — shell-owned table the
      // engine reads to expose `livepeer_bridge_reservations_open*`. A
      // follow-up will invert this with an injected reservation-count
      // callback so the engine package never names a shell schema.
      const result = await deps.db.execute(sql`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int, 0) AS oldest_seconds
        FROM app.reservations
        WHERE state = 'open'
      `);
      const row = result.rows[0] as { count?: number; oldest_seconds?: number } | undefined;
      const count = row?.count ?? 0;
      const oldestSeconds = row?.oldest_seconds ?? 0;
      deps.recorder.setReservationsOpen(count);
      deps.recorder.setReservationOpenOldestSeconds(oldestSeconds);
    } catch (err) {
      onError('reservations', err);
    }
  }

  function sampleNodes(): void {
    try {
      let healthy = 0;
      let degraded = 0;
      let circuitBroken = 0;
      for (const ref of deps.nodeIndex.list()) {
        const status = deps.circuitBreaker.state(ref.id).status;
        if (status === 'healthy') healthy += 1;
        else if (status === 'degraded') degraded += 1;
        else if (status === 'circuit_broken') circuitBroken += 1;
      }
      deps.recorder.setNodesState(NODE_STATE_HEALTHY, healthy);
      deps.recorder.setNodesState(NODE_STATE_DEGRADED, degraded);
      deps.recorder.setNodesState(NODE_STATE_CIRCUIT_BROKEN, circuitBroken);
    } catch (err) {
      onError('nodes', err);
    }
  }

  function samplePayerDaemon(): void {
    try {
      const info = deps.depositInfoSource();
      if (info === null) return;
      deps.recorder.setPayerDaemonDepositWei(info.depositWei.toString());
      deps.recorder.setPayerDaemonReserveWei(info.reserveWei.toString());
    } catch (err) {
      onError('payerDaemon', err);
    }
  }

  async function tickOnce(): Promise<void> {
    await sampleReservations();
    sampleNodes();
    samplePayerDaemon();
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tickOnce();
      }, intervalMs);
      // Don't keep the event loop alive solely on the sampler.
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickOnce,
  };
}
