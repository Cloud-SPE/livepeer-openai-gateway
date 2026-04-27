import { describe, expect, it } from 'vitest';
import type { CostQuote, UsageReport } from '../../interfaces/index.js';
import { InMemoryWallet } from './inMemoryWallet.js';

function quote(overrides: Partial<CostQuote> = {}): CostQuote {
  return {
    workId: 'w-1',
    cents: 0n,
    wei: 0n,
    estimatedTokens: 0,
    model: 'm',
    capability: 'chat',
    callerTier: 'prepaid',
    ...overrides,
  };
}

function usage(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    cents: 0n,
    wei: 0n,
    actualTokens: 0,
    model: 'm',
    capability: 'chat',
    ...overrides,
  };
}

describe('InMemoryWallet', () => {
  it('reserve returns a handle and records an open reservation', async () => {
    const w = new InMemoryWallet();
    const handle = await w.reserve('caller-1', quote({ cents: 100n }));
    expect(handle).toBeDefined();
    const [r] = w.state();
    expect(r?.callerId).toBe('caller-1');
    expect(r?.state).toBe('open');
    expect(r?.quote.cents).toBe(100n);
  });

  it('commit flips an open reservation to committed and records usage', async () => {
    const w = new InMemoryWallet();
    const handle = await w.reserve('c', quote({ cents: 200n }));
    await w.commit(handle, usage({ cents: 150n, actualTokens: 50 }));
    const [r] = w.state();
    expect(r?.state).toBe('committed');
    expect(r?.usage?.cents).toBe(150n);
    expect(r?.usage?.actualTokens).toBe(50);
  });

  it('refund flips an open reservation to refunded', async () => {
    const w = new InMemoryWallet();
    const handle = await w.reserve('c', quote());
    await w.refund(handle);
    const [r] = w.state();
    expect(r?.state).toBe('refunded');
  });

  it('commit on an already-committed handle is a no-op', async () => {
    const w = new InMemoryWallet();
    const handle = await w.reserve('c', quote());
    await w.commit(handle, usage());
    await w.commit(handle, usage({ actualTokens: 999 }));
    const [r] = w.state();
    expect(r?.usage?.actualTokens).toBe(0);
  });

  it('refund on an unknown handle is a no-op', async () => {
    const w = new InMemoryWallet();
    await w.refund({ id: 'nope' });
    expect(w.state()).toEqual([]);
  });

  it('reset clears all reservations', async () => {
    const w = new InMemoryWallet();
    await w.reserve('c', quote());
    await w.reserve('c', quote());
    expect(w.state()).toHaveLength(2);
    w.reset();
    expect(w.state()).toEqual([]);
  });
});
