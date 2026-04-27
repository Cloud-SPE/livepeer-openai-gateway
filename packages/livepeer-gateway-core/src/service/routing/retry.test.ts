import { describe, expect, it } from 'vitest';
import type { NodeRef, ServiceRegistryClient } from '../../providers/serviceRegistry.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { classifyNodeError, runWithRetry, type AttemptResult } from './retry.js';

const cbConfig = { failureThreshold: 3, coolDownSeconds: 60 };

function fakeRegistry(nodes: NodeRef[]): ServiceRegistryClient {
  return {
    async select() {
      return nodes;
    },
    async listKnown() {
      return nodes;
    },
  };
}

function ref(id: string): NodeRef {
  return { id, url: `https://${id}.example`, capabilities: ['chat'], weight: 1 };
}

const POOL: NodeRef[] = [ref('node-a'), ref('node-b'), ref('node-c')];

function deps() {
  return {
    serviceRegistry: fakeRegistry(POOL),
    circuitBreaker: new CircuitBreaker(cbConfig),
    model: 'm',
    tier: 'prepaid' as const,
    capability: 'chat' as const,
    maxAttempts: 3,
    rng: () => 0,
  };
}

describe('classifyNodeError', () => {
  it('never retries once a token has been delivered', () => {
    expect(classifyNodeError(502, true)).toBe('no_retry');
    expect(classifyNodeError(null, true)).toBe('no_retry');
  });
  it('retries on 5xx pre-first-token', () => {
    expect(classifyNodeError(500, false)).toBe('retry_next_node');
    expect(classifyNodeError(503, false)).toBe('retry_next_node');
  });
  it('retries on null status (transport error) pre-first-token', () => {
    expect(classifyNodeError(null, false)).toBe('retry_next_node');
  });
  it('does not retry on 4xx', () => {
    expect(classifyNodeError(400, false)).toBe('no_retry');
    expect(classifyNodeError(404, false)).toBe('no_retry');
  });
});

describe('runWithRetry', () => {
  it('returns on first success without further attempts', async () => {
    let attempts = 0;
    const out = await runWithRetry<number>(deps(), async () => {
      attempts++;
      return { ok: true, value: 42 };
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBe(42);
    expect(attempts).toBe(1);
  });

  it('retries retry_next_node failures up to maxAttempts', async () => {
    let attempts = 0;
    const out = await runWithRetry<number>(
      { ...deps(), maxAttempts: 3 },
      async (): Promise<AttemptResult<number>> => {
        attempts++;
        return {
          ok: false,
          error: new Error('node down'),
          disposition: 'retry_next_node',
          firstTokenDelivered: false,
        };
      },
    );
    expect(out.ok).toBe(false);
    expect(attempts).toBe(3);
  });

  it('bails immediately on no_retry disposition', async () => {
    let attempts = 0;
    await runWithRetry<number>(
      { ...deps(), maxAttempts: 5 },
      async (): Promise<AttemptResult<number>> => {
        attempts++;
        return {
          ok: false,
          error: new Error('4xx'),
          disposition: 'no_retry',
          firstTokenDelivered: false,
        };
      },
    );
    expect(attempts).toBe(1);
  });

  it('bails immediately once firstTokenDelivered is true', async () => {
    let attempts = 0;
    await runWithRetry<number>(
      { ...deps(), maxAttempts: 5 },
      async (): Promise<AttemptResult<number>> => {
        attempts++;
        return {
          ok: false,
          error: new Error('mid-stream'),
          disposition: 'retry_next_node',
          firstTokenDelivered: true,
        };
      },
    );
    expect(attempts).toBe(1);
  });

  it('succeeds on the second attempt after the first fails', async () => {
    let attempts = 0;
    const out = await runWithRetry<string>(deps(), async (): Promise<AttemptResult<string>> => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          error: new Error('transient'),
          disposition: 'retry_next_node',
          firstTokenDelivered: false,
        };
      }
      return { ok: true, value: 'ok' };
    });
    expect(attempts).toBe(2);
    expect(out.ok).toBe(true);
  });
});
