import { describe, it, expect } from 'vitest';
import { loadDatabaseConfig } from './database.js';

describe('loadDatabaseConfig', () => {
  const base = {
    PGHOST: 'h',
    PGUSER: 'u',
    PGPASSWORD: 'p',
    PGDATABASE: 'd',
  };

  it('applies default port and omits optional fields when unset', () => {
    const cfg = loadDatabaseConfig(base as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(5432);
    expect(cfg).not.toHaveProperty('max');
    expect(cfg).not.toHaveProperty('ssl');
  });

  it('coerces PGPOOL_MAX and PGSSL when present', () => {
    const cfg = loadDatabaseConfig({
      ...base,
      PGPOOL_MAX: '25',
      PGSSL: 'true',
      PGPORT: '6543',
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(6543);
    expect(cfg.max).toBe(25);
    expect(cfg.ssl).toBe(true);
  });

  it('treats PGSSL=false as false', () => {
    const cfg = loadDatabaseConfig({ ...base, PGSSL: 'false' } as NodeJS.ProcessEnv);
    expect(cfg.ssl).toBe(false);
  });

  it('throws on missing required env', () => {
    expect(() => loadDatabaseConfig({} as NodeJS.ProcessEnv)).toThrow();
  });
});
