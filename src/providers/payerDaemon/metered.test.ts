/* eslint-disable @typescript-eslint/no-unused-vars -- the fake PayerDaemonClient
   below intentionally accepts every interface method's parameters by name so
   it satisfies the structural type, even when the body ignores them. */
import { describe, expect, it } from 'vitest';
import { withMetrics } from './metered.js';
import { CounterRecorder } from '../metrics/testhelpers.js';
import type {
  CreatePaymentInput,
  CreatePaymentOutput,
  DepositInfo,
  PayerDaemonClient,
  StartSessionInput,
  StartSessionOutput,
} from '../payerDaemon.js';

const ticketParams = {
  recipient: '0x' + 'aa'.repeat(20),
  faceValueWei: 1n,
  winProb: '100',
  recipientRandHash: '0x' + 'ef'.repeat(16),
  seed: '0x' + 'cd'.repeat(16),
  expirationBlock: 100n,
  expirationParams: {
    creationRound: 1n,
    creationRoundBlockHash: '0x' + 'ca'.repeat(32),
  },
};

interface FakeOptions {
  failCreatePayment?: boolean;
  failGetDepositInfo?: boolean;
  depositWei?: bigint;
  reserveWei?: bigint;
}

function makeFake(opts: FakeOptions = {}): PayerDaemonClient {
  return {
    async startSession(_input: StartSessionInput): Promise<StartSessionOutput> {
      return { workId: 'wrk-1' };
    },
    async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentOutput> {
      if (opts.failCreatePayment) throw new Error('boom');
      return {
        paymentBytes: new Uint8Array([1, 2]),
        ticketsCreated: 1,
        expectedValueWei: 42n,
      };
    },
    async closeSession(_workId: string): Promise<void> {},
    async getDepositInfo(): Promise<DepositInfo> {
      if (opts.failGetDepositInfo) throw new Error('rpc down');
      return {
        depositWei: opts.depositWei ?? 1_000_000n,
        reserveWei: opts.reserveWei ?? 250_000n,
        withdrawRound: 0n,
      };
    },
    isHealthy() {
      return true;
    },
    startHealthLoop() {},
    stopHealthLoop() {},
    async close() {},
  };
}

describe('payerDaemon withMetrics', () => {
  it('records ok counter + histogram on successful startSession', async () => {
    const rec = new CounterRecorder();
    const client = withMetrics(makeFake(), rec);

    const out = await client.startSession({
      ticketParams,
      priceInfo: { pricePerUnit: 1n, pixelsPerUnit: 1n },
    });

    expect(out.workId).toBe('wrk-1');
    expect(rec.payerDaemonCalls).toBe(1);
    expect(rec.payerDaemonCallObservations).toBe(1);
  });

  it('records error counter + histogram when underlying call rejects', async () => {
    const rec = new CounterRecorder();
    const client = withMetrics(makeFake({ failCreatePayment: true }), rec);

    await expect(
      client.createPayment({ workId: 'wrk-1', workUnits: 10n }),
    ).rejects.toThrow('boom');
    expect(rec.payerDaemonCalls).toBe(1);
    expect(rec.payerDaemonCallObservations).toBe(1);
  });

  it('drives deposit + reserve gauges from successful getDepositInfo', async () => {
    const rec = new CounterRecorder();
    const client = withMetrics(makeFake({ depositWei: 7n, reserveWei: 3n }), rec);

    const info = await client.getDepositInfo();

    expect(info.depositWei).toBe(7n);
    expect(rec.payerDaemonDepositSets).toBe(1);
    expect(rec.payerDaemonReserveSets).toBe(1);
    expect(rec.payerDaemonCalls).toBe(1);
    expect(rec.payerDaemonCallObservations).toBe(1);
  });

  it('does not set deposit/reserve gauges when getDepositInfo fails', async () => {
    const rec = new CounterRecorder();
    const client = withMetrics(makeFake({ failGetDepositInfo: true }), rec);

    await expect(client.getDepositInfo()).rejects.toThrow('rpc down');
    expect(rec.payerDaemonDepositSets).toBe(0);
    expect(rec.payerDaemonReserveSets).toBe(0);
    // Error path still emits the call/observation pair.
    expect(rec.payerDaemonCalls).toBe(1);
    expect(rec.payerDaemonCallObservations).toBe(1);
  });

  it('forwards lifecycle methods (isHealthy / startHealthLoop / close)', async () => {
    const rec = new CounterRecorder();
    let started = false;
    let stopped = false;
    let closed = false;
    const inner: PayerDaemonClient = {
      ...makeFake(),
      isHealthy: () => true,
      startHealthLoop: () => {
        started = true;
      },
      stopHealthLoop: () => {
        stopped = true;
      },
      close: async () => {
        closed = true;
      },
    };
    const client = withMetrics(inner, rec);

    expect(client.isHealthy()).toBe(true);
    client.startHealthLoop();
    client.stopHealthLoop();
    await client.close();

    expect(started).toBe(true);
    expect(stopped).toBe(true);
    expect(closed).toBe(true);
  });
});
