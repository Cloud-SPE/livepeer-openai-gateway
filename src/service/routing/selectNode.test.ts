import { describe, expect, it } from 'vitest';
import type { NodeRef, ServiceRegistryClient } from '../../providers/serviceRegistry.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { selectNode } from './router.js';
import { NoHealthyNodesError } from '../nodes/errors.js';

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

function ref(id: string, url: string, weight = 1): NodeRef {
  return { id, url, capabilities: ['chat'], weight };
}

describe('selectNode (registry + circuit breaker)', () => {
  it('returns the only daemon candidate when nothing is excluded', async () => {
    const reg = fakeRegistry([ref('a', 'https://a')]);
    const cb = new CircuitBreaker(cbConfig);
    const picked = await selectNode(
      { serviceRegistry: reg, circuitBreaker: cb, rng: () => 0.5 },
      { capability: 'chat', model: 'm', tier: 'prepaid' },
    );
    expect(picked.id).toBe('a');
  });

  it('honors local exclusions from the circuit breaker', async () => {
    const reg = fakeRegistry([ref('a', 'https://a'), ref('b', 'https://b')]);
    const cb = new CircuitBreaker(cbConfig);
    const now = new Date('2026-04-26T12:00:00Z');
    cb.onFailure('a', now);
    cb.onFailure('a', now);
    cb.onFailure('a', now);
    const picked = await selectNode(
      { serviceRegistry: reg, circuitBreaker: cb, rng: () => 0.5, now: () => now },
      { capability: 'chat', model: 'm', tier: 'prepaid' },
    );
    expect(picked.id).toBe('b');
  });

  it('throws NoHealthyNodesError when daemon returns empty', async () => {
    const reg = fakeRegistry([]);
    const cb = new CircuitBreaker(cbConfig);
    await expect(
      selectNode(
        { serviceRegistry: reg, circuitBreaker: cb },
        { capability: 'chat', model: 'm', tier: 'prepaid' },
      ),
    ).rejects.toBeInstanceOf(NoHealthyNodesError);
  });

  it('throws NoHealthyNodesError when every daemon candidate is excluded', async () => {
    const reg = fakeRegistry([ref('a', 'https://a')]);
    const cb = new CircuitBreaker(cbConfig);
    const now = new Date('2026-04-26T12:00:00Z');
    cb.onFailure('a', now);
    cb.onFailure('a', now);
    cb.onFailure('a', now);
    await expect(
      selectNode(
        { serviceRegistry: reg, circuitBreaker: cb, now: () => now },
        { capability: 'chat', model: 'm', tier: 'prepaid' },
      ),
    ).rejects.toBeInstanceOf(NoHealthyNodesError);
  });

  it('weighted-random respects weight distribution under fixed RNG', async () => {
    // weights 1, 9 → with rng=0.05 (5% of 10 = 0.5, picks "a" since "a"
    // weight=1 is consumed first → pick goes negative).
    const reg = fakeRegistry([ref('a', 'https://a', 1), ref('b', 'https://b', 9)]);
    const cb = new CircuitBreaker(cbConfig);
    const a = await selectNode(
      { serviceRegistry: reg, circuitBreaker: cb, rng: () => 0.05 },
      { capability: 'chat', model: 'm', tier: 'prepaid' },
    );
    expect(a.id).toBe('a');
    // rng=0.5 → pick = 5; subtract a's 1 → 4; subtract b's 9 → -5, picks b.
    const b = await selectNode(
      { serviceRegistry: reg, circuitBreaker: cb, rng: () => 0.5 },
      { capability: 'chat', model: 'm', tier: 'prepaid' },
    );
    expect(b.id).toBe('b');
  });
});
