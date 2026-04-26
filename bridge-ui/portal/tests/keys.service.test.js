import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';

// The service imports api singleton; we mock the module so api.{get,post,del}
// are vi.fn() under our control.
vi.mock('../lib/api.js', () => {
  const api = {
    get: vi.fn(),
    post: vi.fn(),
    del: vi.fn(),
  };
  return { api };
});

const { keysService } = await import('../lib/services/keys.service.js');
const { api } = await import('../lib/api.js');

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.del.mockReset();
  keysService.reset();
});

afterEach(() => {
  keysService.reset();
});

describe('keysService.refresh', () => {
  it('populates keys$ from /v1/account/api-keys', async () => {
    api.get.mockResolvedValueOnce({
      keys: [{ id: 'k1', label: 'a', created_at: '2026-04-20', last_used_at: null, revoked_at: null }],
    });
    const out = await keysService.refresh();
    expect(out).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/v1/account/api-keys');
    expect(keysService.value).toHaveLength(1);
  });
});

describe('keysService.create', () => {
  it('optimistically prepends the new key', async () => {
    keysService.reset();
    // seed initial list
    api.get.mockResolvedValueOnce({
      keys: [{ id: 'k0', label: 'old', created_at: '2026-04-19', last_used_at: null, revoked_at: null }],
    });
    await keysService.refresh();

    api.post.mockResolvedValueOnce({
      id: 'k1',
      label: 'new',
      key: 'sk-test-cleartext',
      created_at: '2026-04-20',
    });
    const created = await keysService.create('new');
    expect(created.key).toBe('sk-test-cleartext');

    const list = keysService.value;
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('k1');                 // prepended
    expect(list[0].revoked_at).toBeNull();
    expect(list[1].id).toBe('k0');
  });
});

describe('keysService.revoke', () => {
  beforeEach(async () => {
    api.get.mockResolvedValueOnce({
      keys: [
        { id: 'k1', label: 'one', created_at: '2026-04-20', last_used_at: null, revoked_at: null },
        { id: 'k2', label: 'two', created_at: '2026-04-19', last_used_at: null, revoked_at: null },
      ],
    });
    await keysService.refresh();
  });

  it('optimistically marks revoked_at then confirms on success', async () => {
    api.del.mockResolvedValueOnce(null);
    await keysService.revoke('k1');
    const list = keysService.value;
    expect(list.find((k) => k.id === 'k1').revoked_at).toBeTruthy();
    expect(list.find((k) => k.id === 'k2').revoked_at).toBeNull();
  });

  it('rolls back on error', async () => {
    api.del.mockRejectedValueOnce(new Error('http_412'));
    await expect(keysService.revoke('k1')).rejects.toThrow('http_412');
    const list = keysService.value;
    expect(list.find((k) => k.id === 'k1').revoked_at).toBeNull(); // restored
  });
});

describe('keys$ stream', () => {
  it('emits null after reset', async () => {
    keysService.reset();
    const v = await firstValueFrom(keysService.keys$);
    expect(v).toBeNull();
  });
});
