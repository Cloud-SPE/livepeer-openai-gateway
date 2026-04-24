import { describe, expect, it, vi } from 'vitest';
import type { PayerDaemonClient } from '../../providers/payerDaemon.js';
import type { Quote } from '../../types/node.js';
import { createPaymentsService } from './createPayment.js';
import { createSessionCache } from './sessions.js';
import { PayerDaemonNotHealthyError, QuoteExpiredError } from './errors.js';

function mkQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    ticketParams: {
      recipient: '0x' + 'aa'.repeat(20),
      faceValueWei: 1_000n,
      winProb: '100',
      recipientRandHash: '0x' + 'ef'.repeat(16),
      seed: '0x' + 'cd'.repeat(16),
      expirationBlock: 12345n,
      expirationParams: {
        creationRound: 42n,
        creationRoundBlockHash: '0x' + 'ca'.repeat(32),
      },
    },
    priceInfo: { pricePerUnitWei: 1n, pixelsPerUnit: 1n },
    lastRefreshedAt: new Date(0),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function mkFakeDaemon(): PayerDaemonClient & {
  startedSessions: number;
  createdPayments: number;
  closed: string[];
} {
  const startedSessions = 0;
  const createdPayments = 0;
  const closed: string[] = [];
  const daemon: PayerDaemonClient & {
    startedSessions: number;
    createdPayments: number;
    closed: string[];
  } = {
    startedSessions,
    createdPayments,
    closed,
    async startSession() {
      daemon.startedSessions++;
      return { workId: `wrk-${daemon.startedSessions}` };
    },
    async createPayment() {
      daemon.createdPayments++;
      return {
        paymentBytes: new Uint8Array([1, 2, 3]),
        ticketsCreated: 1,
        expectedValueWei: 500n,
      };
    },
    async closeSession(workId) {
      daemon.closed.push(workId);
    },
    async getDepositInfo() {
      return { depositWei: 10_000n, reserveWei: 0n, withdrawRound: 0n };
    },
    isHealthy: () => true,
    startHealthLoop: () => undefined,
    stopHealthLoop: () => undefined,
    async close() {
      /* noop */
    },
  };
  return daemon;
}

describe('SessionCache', () => {
  it('starts a session on first use and reuses it on subsequent calls', async () => {
    const daemon = mkFakeDaemon();
    const cache = createSessionCache({ payerDaemon: daemon });
    const q = mkQuote();
    const w1 = await cache.getOrStart('node-a', q);
    const w2 = await cache.getOrStart('node-a', q);
    expect(w1).toBe(w2);
    expect(daemon.startedSessions).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('opens a new session when the quote expires', async () => {
    const daemon = mkFakeDaemon();
    let now = new Date(0);
    const cache = createSessionCache({ payerDaemon: daemon, now: () => now });
    const q = mkQuote({ expiresAt: new Date(1000) });
    await cache.getOrStart('node-a', q);
    now = new Date(2000);
    await cache.getOrStart('node-a', q);
    expect(daemon.startedSessions).toBe(2);
  });

  it('opens a new session when ticketParams.expirationBlock changes', async () => {
    const daemon = mkFakeDaemon();
    const cache = createSessionCache({ payerDaemon: daemon });
    await cache.getOrStart('node-a', mkQuote());
    await cache.getOrStart(
      'node-a',
      mkQuote({
        ticketParams: { ...mkQuote().ticketParams, expirationBlock: 99_999n },
      }),
    );
    expect(daemon.startedSessions).toBe(2);
  });

  it('close(nodeId) closes sessions for that node only', async () => {
    const daemon = mkFakeDaemon();
    const cache = createSessionCache({ payerDaemon: daemon });
    await cache.getOrStart('node-a', mkQuote());
    await cache.getOrStart('node-b', mkQuote());
    await cache.close('node-a');
    expect(daemon.closed).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('closeAll drains and clears the cache', async () => {
    const daemon = mkFakeDaemon();
    const cache = createSessionCache({ payerDaemon: daemon });
    await cache.getOrStart('node-a', mkQuote());
    await cache.getOrStart('node-b', mkQuote());
    await cache.closeAll();
    expect(daemon.closed).toHaveLength(2);
    expect(cache.size).toBe(0);
  });
});

describe('PaymentsService.createPaymentForRequest', () => {
  it('returns workId + payment bytes for a healthy daemon and valid quote', async () => {
    const daemon = mkFakeDaemon();
    const cache = createSessionCache({ payerDaemon: daemon });
    const svc = createPaymentsService({ payerDaemon: daemon, sessions: cache });
    const out = await svc.createPaymentForRequest({
      nodeId: 'node-a',
      quote: mkQuote(),
      workUnits: 100n,
    });
    expect(out.workId).toBe('wrk-1');
    expect(out.paymentBytes).toBeInstanceOf(Uint8Array);
    expect(out.expectedValueWei).toBe(500n);
  });

  it('fails closed with PayerDaemonNotHealthyError when daemon reports unhealthy', async () => {
    const daemon = mkFakeDaemon();
    daemon.isHealthy = () => false;
    const cache = createSessionCache({ payerDaemon: daemon });
    const svc = createPaymentsService({ payerDaemon: daemon, sessions: cache });
    await expect(
      svc.createPaymentForRequest({ nodeId: 'node-a', quote: mkQuote(), workUnits: 1n }),
    ).rejects.toBeInstanceOf(PayerDaemonNotHealthyError);
  });

  it('throws QuoteExpiredError when the quote is past its expiry', async () => {
    const daemon = mkFakeDaemon();
    const cache = createSessionCache({ payerDaemon: daemon });
    const svc = createPaymentsService({ payerDaemon: daemon, sessions: cache });
    await expect(
      svc.createPaymentForRequest({
        nodeId: 'node-a',
        quote: mkQuote({ expiresAt: new Date(Date.now() - 1000) }),
        workUnits: 1n,
      }),
    ).rejects.toBeInstanceOf(QuoteExpiredError);
  });

  it('surfaces createPayment errors from the provider', async () => {
    const daemon = mkFakeDaemon();
    const failure = new Error('boom');
    daemon.createPayment = vi.fn(async () => {
      throw failure;
    });
    const cache = createSessionCache({ payerDaemon: daemon });
    const svc = createPaymentsService({ payerDaemon: daemon, sessions: cache });
    await expect(
      svc.createPaymentForRequest({ nodeId: 'node-a', quote: mkQuote(), workUnits: 1n }),
    ).rejects.toBe(failure);
  });
});
