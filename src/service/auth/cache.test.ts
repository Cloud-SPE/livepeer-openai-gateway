import { describe, expect, it } from 'vitest';
import { TtlCache } from './cache.js';

describe('TtlCache', () => {
  it('returns null for missing keys', () => {
    const c = new TtlCache<string, number>(10_000);
    expect(c.get('nope')).toBeNull();
  });

  it('round-trips a value within TTL', () => {
    const c = new TtlCache<string, number>(10_000);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(1);
  });

  it('expires entries after the TTL elapses', async () => {
    const c = new TtlCache<string, number>(10);
    c.set('a', 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.get('a')).toBeNull();
    expect(c.size).toBe(0);
  });

  it('delete removes an entry', () => {
    const c = new TtlCache<string, number>(10_000);
    c.set('a', 1);
    c.delete('a');
    expect(c.get('a')).toBeNull();
  });

  it('clear empties the cache', () => {
    const c = new TtlCache<string, number>(10_000);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
  });
});
