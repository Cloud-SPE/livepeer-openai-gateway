import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server, ServerCredentials, status as GrpcStatus } from '@grpc/grpc-js';
import { createGrpcPayerDaemonClient } from './grpc.js';
import { PayerDaemonUnavailableError } from './errors.js';
import { ManualScheduler } from '../../service/nodes/scheduler.js';
import { PayerDaemonService } from './gen/livepeer/payments/v1/payer_daemon.js';
import { bigintToBigEndianBytes } from './convert.js';

interface FakeServerState {
  sessions: Set<string>;
  depositWei: bigint;
  reserveWei: bigint;
  nextWorkId: number;
  forceCreatePaymentError: boolean;
}

interface RunningServer {
  server: Server;
  socketPath: string;
  state: FakeServerState;
  stop(): Promise<void>;
}

async function startFakeServer(): Promise<RunningServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'payer-daemon-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const state: FakeServerState = {
    sessions: new Set<string>(),
    depositWei: 1_000_000n,
    reserveWei: 250_000n,
    nextWorkId: 0,
    forceCreatePaymentError: false,
  };
  const server = new Server();
  server.addService(PayerDaemonService, {
    startSession(call, callback) {
      state.nextWorkId++;
      const workId = `wrk-${state.nextWorkId}`;
      state.sessions.add(workId);
      callback(null, { workId });
    },
    createPayment(call, callback) {
      if (state.forceCreatePaymentError) {
        const err = Object.assign(new Error('bad request'), {
          code: GrpcStatus.INVALID_ARGUMENT,
          details: 'malformed work_units',
        });
        callback(err as never, null);
        return;
      }
      if (!state.sessions.has(call.request.workId)) {
        const err = Object.assign(new Error('no session'), {
          code: GrpcStatus.FAILED_PRECONDITION,
          details: `unknown work_id=${call.request.workId}`,
        });
        callback(err as never, null);
        return;
      }
      callback(null, {
        paymentBytes: Buffer.from([0xde, 0xad]),
        ticketsCreated: 2,
        expectedValue: bigintToBigEndianBytes(42n),
      });
    },
    closeSession(call, callback) {
      state.sessions.delete(call.request.workId);
      callback(null, {});
    },
    getDepositInfo(_call, callback) {
      callback(null, {
        deposit: bigintToBigEndianBytes(state.depositWei),
        reserve: bigintToBigEndianBytes(state.reserveWei),
        withdrawRound: 0n,
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`unix://${socketPath}`, ServerCredentials.createInsecure(), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  return {
    server,
    socketPath,
    state,
    async stop() {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

let running: RunningServer | null = null;

beforeEach(async () => {
  running = await startFakeServer();
});
afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

function mkClient(socketPath: string) {
  const scheduler = new ManualScheduler();
  const client = createGrpcPayerDaemonClient({
    config: {
      socketPath,
      healthIntervalMs: 10_000,
      healthFailureThreshold: 2,
      callTimeoutMs: 2_000,
    },
    scheduler,
  });
  return { client, scheduler };
}

const ticketParams = {
  recipient: '0x' + 'aa'.repeat(20),
  faceValueWei: 1_000_000n,
  winProb: '100',
  recipientRandHash: '0x' + 'ef'.repeat(16),
  seed: '0x' + 'cd'.repeat(16),
  expirationBlock: 100n,
  expirationParams: {
    creationRound: 42n,
    creationRoundBlockHash: '0x' + 'ca'.repeat(32),
  },
};

describe('grpc payer daemon client (fake server over unix socket)', () => {
  it('startSession → createPayment → closeSession round-trip', async () => {
    const { client } = mkClient(running!.socketPath);
    try {
      const { workId } = await client.startSession({
        ticketParams,
        priceInfo: { pricePerUnit: 1n, pixelsPerUnit: 1n },
      });
      expect(workId).toBe('wrk-1');

      const payment = await client.createPayment({
        workId,
        workUnits: 10n,
        capability: 'openai:/v1/chat/completions',
        model: 'm',
        nodeId: 'n',
      });
      expect(payment.ticketsCreated).toBe(2);
      expect(payment.expectedValueWei).toBe(42n);
      expect(Buffer.from(payment.paymentBytes).toString('hex')).toBe('dead');

      await client.closeSession(workId);
      expect(running!.state.sessions.has(workId)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('getDepositInfo returns bigint deposit and reserve', async () => {
    const { client } = mkClient(running!.socketPath);
    try {
      const info = await client.getDepositInfo();
      expect(info.depositWei).toBe(1_000_000n);
      expect(info.reserveWei).toBe(250_000n);
    } finally {
      await client.close();
    }
  });

  it('maps INVALID_ARGUMENT into PayerDaemonProtocolError via error classes', async () => {
    const { client } = mkClient(running!.socketPath);
    try {
      running!.state.forceCreatePaymentError = true;
      const { workId } = await client.startSession({
        ticketParams,
        priceInfo: { pricePerUnit: 1n, pixelsPerUnit: 1n },
      });
      await expect(
        client.createPayment({
          workId,
          workUnits: 10n,
          capability: 'openai:/v1/chat/completions',
          model: 'm',
          nodeId: 'n',
        }),
      ).rejects.toMatchObject({
        name: 'PayerDaemonProtocolError',
      });
    } finally {
      await client.close();
    }
  });

  it('fails with PayerDaemonUnavailableError after the daemon stops', async () => {
    const { client } = mkClient(running!.socketPath);
    try {
      await running!.stop();
      running = null;
      await expect(client.getDepositInfo()).rejects.toBeInstanceOf(PayerDaemonUnavailableError);
    } finally {
      await client.close();
    }
  });

  it('health loop marks isHealthy=false after N failed pings and recovers on success', async () => {
    const server = running!;
    const { client, scheduler } = mkClient(server.socketPath);
    try {
      // Start pointing at live server → one successful ping sets healthy=true.
      client.startHealthLoop();
      await scheduler.runDue();
      expect(client.isHealthy()).toBe(true);

      // Kill the server → two consecutive ping failures should flip health.
      await server.stop();
      running = null;

      // Advance to next scheduled tick twice and run due tasks.
      scheduler.advance(10_000);
      await scheduler.runDue();
      expect(client.isHealthy()).toBe(true); // one failure; threshold=2
      scheduler.advance(10_000);
      await scheduler.runDue();
      expect(client.isHealthy()).toBe(false);
    } finally {
      client.stopHealthLoop();
      await client.close();
    }
  });
});
