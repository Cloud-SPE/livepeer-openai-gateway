import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
  signIn: vi.fn(),
}));

const { customersService } = await import('../lib/services/customers.service.js');
const { api } = await import('../lib/api.js');

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.del.mockReset();
  customersService.reset();
});

describe('customersService.search', () => {
  it('builds the right query string from params', async () => {
    api.get.mockResolvedValueOnce({ customers: [], next_cursor: null });
    await customersService.search({ q: 'alice', tier: 'free', status: 'active', limit: 10 });
    const url = api.get.mock.calls[0][0];
    expect(url).toContain('q=alice');
    expect(url).toContain('tier=free');
    expect(url).toContain('status=active');
    expect(url).toContain('limit=10');
  });

  it('publishes the result on results$', async () => {
    const fixture = { customers: [{ id: 'c1', email: 'a@x' }], next_cursor: null };
    api.get.mockResolvedValueOnce(fixture);
    const out = await customersService.search({});
    expect(out).toEqual(fixture);
    expect(customersService.results).toEqual(fixture);
  });
});

describe('customersService.select / actions', () => {
  it('select() pushes onto selected$', async () => {
    api.get.mockResolvedValueOnce({ id: 'c1', email: 'a@x' });
    const detail = await customersService.select('c1');
    expect(api.get).toHaveBeenCalledWith('/admin/customers/c1');
    expect(detail.id).toBe('c1');
    expect(customersService.selected).toEqual(detail);
  });

  it('refund POSTs the body', async () => {
    api.post.mockResolvedValueOnce({ ok: true });
    await customersService.refund('c1', { stripeSessionId: 'cs_x', reason: 'why' });
    expect(api.post).toHaveBeenCalledWith('/admin/customers/c1/refund', {
      stripeSessionId: 'cs_x',
      reason: 'why',
    });
  });

  it('suspend / unsuspend POST empty body', async () => {
    api.post.mockResolvedValueOnce({ ok: true });
    await customersService.suspend('c1');
    expect(api.post.mock.calls[0]).toEqual(['/admin/customers/c1/suspend', {}]);

    api.post.mockResolvedValueOnce({ ok: true });
    await customersService.unsuspend('c1');
    expect(api.post.mock.calls[1]).toEqual(['/admin/customers/c1/unsuspend', {}]);
  });

  it('issueKey POSTs a label', async () => {
    api.post.mockResolvedValueOnce({
      id: 'k1',
      label: 'op',
      key: 'sk-test-x',
      created_at: '2026-04-26T00:00:00Z',
    });
    const out = await customersService.issueKey('c1', 'op');
    expect(api.post).toHaveBeenCalledWith('/admin/customers/c1/api-keys', { label: 'op' });
    expect(out.key).toBe('sk-test-x');
  });
});
