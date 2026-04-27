import { describe, expect, it } from 'vitest';
import { createAdminAuthResolver } from './authResolver.js';
import type { AdminConfig } from '../../config/admin.js';

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    token: 'admin-token-fixture-123',
    ipAllowlist: [],
    ...overrides,
  };
}

describe('createAdminAuthResolver', () => {
  it('resolves with actor from X-Admin-Actor when token matches', async () => {
    const resolver = createAdminAuthResolver({ config: makeConfig() });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'admin-token-fixture-123', 'x-admin-actor': 'mike.z' },
      ip: '127.0.0.1',
    });
    expect(result).toEqual({ actor: 'mike.z' });
  });

  it('falls back to truncated token hash when X-Admin-Actor is missing', async () => {
    const resolver = createAdminAuthResolver({ config: makeConfig() });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'admin-token-fixture-123' },
      ip: '127.0.0.1',
    });
    expect(result?.actor).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to token hash when X-Admin-Actor is malformed', async () => {
    const resolver = createAdminAuthResolver({ config: makeConfig() });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'admin-token-fixture-123', 'x-admin-actor': 'INVALID/CHARS' },
      ip: '127.0.0.1',
    });
    expect(result?.actor).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns null when X-Admin-Token is missing', async () => {
    const resolver = createAdminAuthResolver({ config: makeConfig() });
    const result = await resolver.resolve({ headers: {}, ip: '127.0.0.1' });
    expect(result).toBeNull();
  });

  it('returns null when X-Admin-Token has wrong length', async () => {
    const resolver = createAdminAuthResolver({ config: makeConfig() });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'short' },
      ip: '127.0.0.1',
    });
    expect(result).toBeNull();
  });

  it('returns null when X-Admin-Token has correct length but wrong value', async () => {
    const resolver = createAdminAuthResolver({ config: makeConfig() });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'wrong-token-fixture-xyz' },
      ip: '127.0.0.1',
    });
    expect(result).toBeNull();
  });

  it('returns null when IP allowlist is non-empty and IP is not in it', async () => {
    const resolver = createAdminAuthResolver({
      config: makeConfig({ ipAllowlist: ['10.0.0.1'] }),
    });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'admin-token-fixture-123' },
      ip: '127.0.0.1',
    });
    expect(result).toBeNull();
  });

  it('resolves when IP is in the allowlist', async () => {
    const resolver = createAdminAuthResolver({
      config: makeConfig({ ipAllowlist: ['10.0.0.1', '127.0.0.1'] }),
    });
    const result = await resolver.resolve({
      headers: { 'x-admin-token': 'admin-token-fixture-123' },
      ip: '127.0.0.1',
    });
    expect(result?.actor).toMatch(/^[0-9a-f]{16}$/);
  });
});
