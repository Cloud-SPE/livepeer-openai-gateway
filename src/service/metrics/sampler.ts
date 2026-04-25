// Periodic sampler for "snapshot" metrics that only make sense if read on a
// timer rather than at the moment of an event. Mirrors the
// service-registry's `internal/service/metrics/sampler.go` shape.
//
// Pass A: this file is created but NOT started by the composition root —
// Pass B wires `start()` from main.ts so the sampler ticks alongside the
// HTTP server.
//
// Per tick the sampler:
//   1. SELECTs (count, oldest-age) of `state='open'` reservations and feeds
//      `setReservationsOpen` / `setReservationOpenOldestSeconds`.
//   2. Walks the in-memory NodeBook and emits `setNodesState(state, n)` for
//      each of the four states ({healthy, degraded, circuit_broken,
//      disabled}). disabled = `config.enabled === false`; the other three
//      come from `circuit.status`.
//   3. Reads the cached deposit-info via the supplied DepositInfoSource and
//      sets `setPayerDaemonDepositWei` + `setPayerDaemonReserveWei`. The
//      source is supplied by the composition root so the sampler does NOT
//      issue a fresh RPC — it reads whatever the existing health-loop has
//      already populated.
//
// All db / NodeBook / DepositInfoSource calls are wrapped in try/catch so a
// single failing source doesn't break the rest of the tick.

import { sql } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import type { NodeBook } from '../nodes/nodebook.js';
import type { DepositInfo } from '../../providers/payerDaemon.js';
import {
  NODE_STATE_CIRCUIT_BROKEN,
  NODE_STATE_DEGRADED,
  NODE_STATE_DISABLED,
  NODE_STATE_HEALTHY,
  type NodeState,
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
  nodeBook: NodeBook;
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
      const result = await deps.db.execute(sql`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int, 0) AS oldest_seconds
        FROM reservation
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
      const counts: Record<NodeState, number> = {
        [NODE_STATE_HEALTHY]: 0,
        [NODE_STATE_DEGRADED]: 0,
        [NODE_STATE_CIRCUIT_BROKEN]: 0,
        [NODE_STATE_DISABLED]: 0,
      };
      for (const entry of deps.nodeBook.list()) {
        if (!entry.config.enabled) {
          counts[NODE_STATE_DISABLED] += 1;
          continue;
        }
        // circuit.status is one of healthy / degraded / circuit_broken — same
        // string values as the metric label so we can index directly.
        counts[entry.circuit.status] += 1;
      }
      deps.recorder.setNodesState(NODE_STATE_HEALTHY, counts[NODE_STATE_HEALTHY]);
      deps.recorder.setNodesState(NODE_STATE_DEGRADED, counts[NODE_STATE_DEGRADED]);
      deps.recorder.setNodesState(
        NODE_STATE_CIRCUIT_BROKEN,
        counts[NODE_STATE_CIRCUIT_BROKEN],
      );
      deps.recorder.setNodesState(NODE_STATE_DISABLED, counts[NODE_STATE_DISABLED]);
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
