import { describe, expect, it } from 'vitest';
import { knownEncodings, resolveEncodingForModel } from './tokenizer.js';

describe('tokenizer config', () => {
  it('resolves the v1 models to cl100k_base', () => {
    expect(resolveEncodingForModel('model-small')).toBe('cl100k_base');
    expect(resolveEncodingForModel('model-medium')).toBe('cl100k_base');
    expect(resolveEncodingForModel('model-large')).toBe('cl100k_base');
  });
  it('returns null for unknown models', () => {
    expect(resolveEncodingForModel('model-nonexistent')).toBeNull();
  });
  it('knownEncodings is non-empty and deduped', () => {
    const encs = knownEncodings();
    expect(encs.length).toBeGreaterThan(0);
    expect(new Set(encs).size).toBe(encs.length);
  });
});
