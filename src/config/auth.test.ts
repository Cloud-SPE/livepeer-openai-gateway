import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from './auth.js';

describe('loadAuthConfig', () => {
  it('accepts minimum env and applies defaults', () => {
    const cfg = loadAuthConfig({
      API_KEY_PEPPER: 'pepper-of-sufficient-length',
    } as NodeJS.ProcessEnv);
    expect(cfg.envPrefix).toBe('live');
    expect(cfg.cacheTtlMs).toBe(60_000);
  });

  it('accepts overrides', () => {
    const cfg = loadAuthConfig({
      API_KEY_PEPPER: 'pepper-of-sufficient-length',
      API_KEY_ENV_PREFIX: 'test',
      AUTH_CACHE_TTL_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(cfg.envPrefix).toBe('test');
    expect(cfg.cacheTtlMs).toBe(5000);
  });

  it('rejects a too-short pepper', () => {
    expect(() => loadAuthConfig({ API_KEY_PEPPER: 'short' } as NodeJS.ProcessEnv)).toThrow();
  });
});
