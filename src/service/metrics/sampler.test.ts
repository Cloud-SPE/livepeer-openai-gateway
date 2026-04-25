import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetricsSampler, type DepositInfoSource } from './sampler.js';
import { CounterRecorder } from '../../providers/metrics/testhelpers.js';
import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import type { Db } from '../../repo/db.js';
import type { DepositInfo } from '../../providers/payerDaemon.js';
import {
  NODE_STATE_CIRCUIT_BROKEN,
  NODE_STATE_DEGRADED,
  NODE_STATE_DISABLED,
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

interface FakeNodeBookEntry {
  enabled: boolean;
  status: 'healthy' | 'degraded' | 'circuit_broken';
}

function fakeNodeBook(entries: FakeNodeBookEntry[]): NodeBook {
  const list: NodeEntry[] = entries.map((e) => ({
    config: { enabled: e.enabled } as never,
    circuit: { status: e.status } as never,
    quotes: new Map(),
  }));
  return {
    list: () => list,
  } as unknown as NodeBook;
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
      nodeBook: fakeNodeBook([]),
      depositInfoSource: liveSource(null),
      recorder: rec,
    });

    await sampler.tickOnce();

    expect(rec.reservationsOpenSets).toBe(1);
    expect(rec.reservationOldestSets).toBe(1);
  });

  it('emits four setNodesState calls — one per state — with disabled overriding circuit', async () => {
    const rec = new CounterRecorder();
    const seen: Array<{ state: NodeState; n: number }> = [];
    const original = rec.setNodesState.bind(rec);
    rec.setNodesState = (state: NodeState, n: number): void => {
      seen.push({ state, n });
      original(state, n);
    };

    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeBook: fakeNodeBook([
        { enabled: true, status: 'healthy' },
        { enabled: true, status: 'healthy' },
        { enabled: true, status: 'degraded' },
        { enabled: true, status: 'circuit_broken' },
        // disabled overrides circuit status:
        { enabled: false, status: 'healthy' },
      ]),
      depositInfoSource: liveSource(null),
      recorder: rec,
    });

    await sampler.tickOnce();

    expect(rec.nodesStateSets).toBe(4);
    const lookup = new Map(seen.map((s) => [s.state, s.n]));
    expect(lookup.get(NODE_STATE_HEALTHY)).toBe(2);
    expect(lookup.get(NODE_STATE_DEGRADED)).toBe(1);
    expect(lookup.get(NODE_STATE_CIRCUIT_BROKEN)).toBe(1);
    expect(lookup.get(NODE_STATE_DISABLED)).toBe(1);
  });

  it('updates payer-daemon deposit/reserve gauges when the source returns a value', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeBook: fakeNodeBook([]),
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
      nodeBook: fakeNodeBook([]),
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
      nodeBook: fakeNodeBook([{ enabled: true, status: 'healthy' }]),
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
    expect(rec.nodesStateSets).toBe(4);
    expect(rec.payerDaemonDepositSets).toBe(1);
  });

  it('start()/stop() drives ticks via setInterval and respects intervalMs', async () => {
    const rec = new CounterRecorder();
    const sampler = createMetricsSampler({
      db: fakeDb(),
      nodeBook: fakeNodeBook([]),
      depositInfoSource: liveSource(null),
      recorder: rec,
      intervalMs: 1_000,
    });

    sampler.start();
    // No tick yet — start() schedules the first tick at intervalMs, not immediately.
    expect(rec.nodesStateSets).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rec.nodesStateSets).toBe(4);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(rec.nodesStateSets).toBe(8);

    sampler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    // No further ticks after stop().
    expect(rec.nodesStateSets).toBe(8);
  });
});
