import { describe, expect, it } from 'vitest';
import type { Quote } from '../../types/node.js';
import { QuoteCache } from './quoteCache.js';

function quote(expiresAt: Date): Quote {
  return {
    ticketParams: {
      recipient: '0x' + 'aa'.repeat(20),
      faceValueWei: 1n,
      winProb: '0x01',
      recipientRandHash: '0x' + 'de'.repeat(32),
      seed: '0x' + 'be'.repeat(32),
      expirationBlock: 1n,
      expirationParams: {
        creationRound: 1n,
        creationRoundBlockHash: '0x' + 'ca'.repeat(32),
      },
    },
    priceInfo: { pricePerUnitWei: 1n, pixelsPerUnit: 1n },
    modelPrices: {},
    lastRefreshedAt: new Date(),
    expiresAt,
  };
}

describe('QuoteCache', () => {
  it('get returns null for unknown key', () => {
    const cache = new QuoteCache();
    expect(cache.get('node-a', 'openai:/v1/chat/completions')).toBeNull();
  });

  it('set + get round-trips a fresh quote', () => {
    const cache = new QuoteCache();
    const q = quote(new Date(Date.now() + 60_000));
    cache.set('node-a', 'openai:/v1/chat/completions', q);
    expect(cache.get('node-a', 'openai:/v1/chat/completions')).toBe(q);
  });

  it('get returns null after expiration', () => {
    const cache = new QuoteCache();
    const q = quote(new Date('2026-04-26T12:00:00Z'));
    cache.set('node-a', 'openai:/v1/chat/completions', q);
    expect(
      cache.get('node-a', 'openai:/v1/chat/completions', new Date('2026-04-26T13:00:00Z')),
    ).toBeNull();
  });

  it('deleteNode drops all of a node\'s quotes', () => {
    const cache = new QuoteCache();
    const q = quote(new Date(Date.now() + 60_000));
    cache.set('a', 'cap1', q);
    cache.set('a', 'cap2', q);
    cache.set('b', 'cap1', q);
    cache.deleteNode('a');
    expect(cache.get('a', 'cap1')).toBeNull();
    expect(cache.get('a', 'cap2')).toBeNull();
    expect(cache.get('b', 'cap1')).toBe(q);
  });

  it('replaceNode atomically swaps a node\'s quotes', () => {
    const cache = new QuoteCache();
    const q1 = quote(new Date(Date.now() + 60_000));
    const q2 = quote(new Date(Date.now() + 60_000));
    cache.set('a', 'old-cap', q1);
    cache.replaceNode('a', new Map([['new-cap', q2]]));
    expect(cache.get('a', 'old-cap')).toBeNull();
    expect(cache.get('a', 'new-cap')).toBe(q2);
  });
});
