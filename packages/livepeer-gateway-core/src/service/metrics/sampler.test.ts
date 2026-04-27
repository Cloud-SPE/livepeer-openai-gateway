import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetricsSampler, type DepositInfoSource } from './sampler.js';
import { CounterRecorder } from '../../providers/metrics/testhelpers.js';
import { CircuitBreaker } from '../routing/circuitBreaker.js';
import { createNodeIndex } from '../routing/nodeIndex.js';
import type { Db } from '../../repo/db.js';
import type { DepositInfo } from '../../providers/payerDaemon.js';
import type { NodeRef } from '../../providers/serviceRegistry.js';
import {
  NODE_STATE_CIRCUIT_BROKEN,
  NODE_STATE_DEGRADED,
  NODE_STATE_HEALTHY,
  type NodeState,
} from '../../providers/metrics/recorder.js';

interface FakeDbOptions {
  reservationCount?: number;
  oldestSeconds?: number;
  shouldThrow?: boolean;
}

function fakeDb(opts: FakeDbOptions = {}): Db {
  const execute = vi.fn(async () => {
    if (opts.shouldThrow) throw new Error('db down');
    return {
      rows: [
        {
          count: opts.reservationCount ?? 3,
          oldest_seconds: opts.oldestSeconds ?? 17,
        },
      ],
    };
  });
  return { execute } as unknown as Db;
}

function mkRef(id: string): NodeRef {
  return { id, url: `https://${id}.example`, capabilities: ['chat'], weight: 1 };
}

const liveSource = (info: DepositInfo | null): DepositInfoSource => () => info;

describe('createMetricsSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets reservations gauges from the SQL count + oldest age', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb({ reservationCount: 5, oldestSeconds: 42 }),
      nodeIndex: createNodeIndex(),
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5, coolDownSeconds: 30 }),
      depositInfoSource: liveSource(null),
      recorder: rec,
    });

    await sampler.tickOnce();

    expect(rec.reservationsOpenSets).toBe(1);
    expect(rec.reservationOldestSets).toBe(1);
  });

  it('emits one setNodesState call per live state (healthy/degraded/circuit_broken)', async () => {
    const rec = new CounterRecorder();
    const seen: Array<{ state: NodeState; n: number }> = [];
    const original = rec.setNodesState.bind(rec);
    rec.setNodesState = (state: NodeState, n: number): void => {
      seen.push({ state, n });
      original(state, n);
    };

    const refs = ['n1', 'n2', 'n3', 'n4'].map(mkRef);
    const nodeIndex = createNodeIndex(refs);

    // Build a breaker with mixed states. Threshold=2 so a single onFailure
    // moves the node into 'degraded'; a second onFailure trips it.
    const cb = new CircuitBreaker({ failureThreshold: 2, coolDownSeconds: 30 });
    const now = new Date();
    // n1: healthy (no actions)
    // n2: healthy
    // n3: degraded (one failure under threshold)
    cb.onFailure('n3', now);
    // n4: circuit_broken (two failures hits threshold)
    cb.onFailure('n4', now);
    cb.onFailure('n4', now);

    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeIndex,
      circuitBreaker: cb,
      depositInfoSource: liveSource(null),
      recorder: rec,
    });

    await sampler.tickOnce();

    expect(rec.nodesStateSets).toBe(3);
    const lookup = new Map(seen.map((s) => [s.state, s.n]));
    expect(lookup.get(NODE_STATE_HEALTHY)).toBe(2);
    expect(lookup.get(NODE_STATE_DEGRADED)).toBe(1);
    expect(lookup.get(NODE_STATE_CIRCUIT_BROKEN)).toBe(1);
  });

  it('updates payer-daemon deposit/reserve gauges when the source returns a value', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeIndex: createNodeIndex(),
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5, coolDownSeconds: 30 }),
      depositInfoSource: liveSource({
        depositWei: 9_999n,
        reserveWei: 7_777n,
        withdrawRound: 0n,
      }),
      recorder: rec,
    });

    await sampler.tickOnce();

    expect(rec.payerDaemonDepositSets).toBe(1);
    expect(rec.payerDaemonReserveSets).toBe(1);
  });

  it('skips deposit/reserve gauge update when the source returns null', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeIndex: createNodeIndex(),
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5, coolDownSeconds: 30 }),
      depositInfoSource: liveSource(null),
      recorder: rec,
    });

    await sampler.tickOnce();

    expect(rec.payerDaemonDepositSets).toBe(0);
    expect(rec.payerDaemonReserveSets).toBe(0);
  });

  it('isolates per-source failures (db throws → nodes + payerDaemon still emit)', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb({ shouldThrow: true }),
      nodeIndex: createNodeIndex([mkRef('n1')]),
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5, coolDownSeconds: 30 }),
      depositInfoSource: liveSource({
        depositWei: 1n,
        reserveWei: 0n,
        withdrawRound: 0n,
      }),
      recorder: rec,
      onError: () => undefined,
    });

    await sampler.tickOnce();

    // db source failed — no reservation gauges.
    expect(rec.reservationsOpenSets).toBe(0);
    // Other sources still ran.
    expect(rec.nodesStateSets).toBe(3);
    expect(rec.payerDaemonDepositSets).toBe(1);
  });

  it('start()/stop() drives ticks via setInterval and respects intervalMs', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeIndex: createNodeIndex(),
      circuitBreaker: new CircuitBreaker({ failureThreshold: 5, coolDownSeconds: 30 }),
      depositInfoSource: liveSource(null),
      recorder: rec,
      intervalMs: 1_000,
    });

    sampler.start();
    // No tick yet — start() schedules the first tick at intervalMs, not immediately.
    expect(rec.nodesStateSets).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rec.nodesStateSets).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rec.nodesStateSets).toBe(6);

    sampler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    // No further ticks after stop().
    expect(rec.nodesStateSets).toBe(6);
  });
});

