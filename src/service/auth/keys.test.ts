import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, generateApiKey, hashApiKey, verifyApiKey } from './keys.js';

describe('service/auth/keys', () => {
  it('generates keys matching the sk-<env>-<43-char> pattern', () => {
    const live = generateApiKey('live');
    const test = generateApiKey('test');
    expect(live).toMatch(API_KEY_PATTERN);
    expect(test).toMatch(API_KEY_PATTERN);
    expect(live.startsWith('sk-live-')).toBe(true);
    expect(test.startsWith('sk-test-')).toBe(true);
  });

  it('generates unique keys across calls', () => {
    const a = generateApiKey('live');
    const b = generateApiKey('live');
    expect(a).not.toBe(b);
  });

  it('hashApiKey is deterministic for the same pepper+plaintext', () => {
    const p = 'pepper-for-test-0123';
    const k = 'sk-live-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    expect(hashApiKey(p, k)).toBe(hashApiKey(p, k));
  });

  it('hashApiKey differs when pepper changes', () => {
    const k = 'sk-live-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    expect(hashApiKey('pepper-one-aaaaaaaa', k)).not.toBe(hashApiKey('pepper-two-bbbbbbbb', k));
  });

  it('verifyApiKey returns true on equal hashes and false on different', () => {
    const h1 = hashApiKey('pepper-equal-0000', 'x');
    const h2 = hashApiKey('pepper-equal-0000', 'x');
    const h3 = hashApiKey('pepper-other-0000', 'x');
    expect(verifyApiKey(h1, h2)).toBe(true);
    expect(verifyApiKey(h1, h3)).toBe(false);
  });

  it('verifyApiKey short-circuits on different lengths without throwing', () => {
    expect(verifyApiKey('abcd', 'abcdef')).toBe(false);
  });
});
