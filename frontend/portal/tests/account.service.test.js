import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api.js', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    del: vi.fn(),
  },
}));

const { accountService } = await import('../lib/services/account.service.js');
const { api } = await import('../lib/api.js');

beforeEach(() => {
  api.get.mockReset();
  accountService.signOut();
});

describe('accountService', () => {
  it('refresh() pushes account into account$', async () => {
    const account = { id: 'c1', email: 'a@x.io', tier: 'prepaid', balance_usd: '10.00' };
    api.get.mockResolvedValueOnce(account);
    await accountService.refresh();
    expect(accountService.value).toEqual(account);
  });

  it('signOut() clears account$ to null', async () => {
    api.get.mockResolvedValueOnce({ id: 'c2' });
    await accountService.refresh();
    expect(accountService.value).toBeTruthy();
    accountService.signOut();
    expect(accountService.value).toBeNull();
  });

  it('refresh() propagates api errors', async () => {
    api.get.mockRejectedValueOnce(new Error('boom'));
    await expect(accountService.refresh()).rejects.toThrow('boom');
  });
});
