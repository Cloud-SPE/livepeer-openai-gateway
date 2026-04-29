import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, createApi } from '../lib/api-base.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeResponse({ status = 200, json = {}, contentType = 'application/json' } = {}) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('createApi', () => {
  it('attaches auth headers from getAuthHeaders on each request', async () => {
    globalThis.fetch.mockResolvedValueOnce(makeResponse({ json: { ok: true } }));
    const api = createApi({
      baseUrl: 'https://b.test',
      getAuthHeaders: () => ({ authorization: 'Bearer foo' }),
      onUnauthorized: () => {},
      parseResponse: (_m, _p, body) => body,
    });

    await api.get('/v1/account');

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://b.test/v1/account');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer foo');
  });

  it('routes parseResponse with the request method and path', async () => {
    globalThis.fetch.mockResolvedValueOnce(makeResponse({ json: { id: 'k1' } }));
    const parse = vi.fn((method, path, body) => ({ method, path, body }));
    const api = createApi({
      baseUrl: '',
      getAuthHeaders: () => ({}),
      onUnauthorized: () => {},
      parseResponse: parse,
    });

    const out = await api.post('/v1/account/api-keys', { label: 'x' });
    expect(parse).toHaveBeenCalledWith('POST', '/v1/account/api-keys', { id: 'k1' });
    expect(out.method).toBe('POST');
  });

  it('calls onUnauthorized + throws on 401', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      makeResponse({
        status: 401,
        json: { error: { message: 'unauthorized' } },
      }),
    );
    const onUnauth = vi.fn();
    const api = createApi({
      baseUrl: '',
      getAuthHeaders: () => ({ authorization: 'Bearer bad' }),
      onUnauthorized: onUnauth,
      parseResponse: (_m, _p, body) => body,
    });

    await expect(api.get('/v1/account')).rejects.toThrow(ApiError);
    expect(onUnauth).toHaveBeenCalledOnce();
  });

  it('throws ApiError with message from server body on non-2xx', async () => {
    globalThis.fetch.mockResolvedValueOnce(
      makeResponse({
        status: 400,
        json: { error: { message: 'bad request', type: 'InvalidRequest' } },
      }),
    );
    const api = createApi({
      baseUrl: '',
      getAuthHeaders: () => ({}),
      onUnauthorized: () => {},
      parseResponse: (_m, _p, body) => body,
    });

    try {
      await api.get('/v1/account');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.message).toBe('bad request');
      expect(e.status).toBe(400);
    }
  });

  it('returns null on 204 (DELETE)', async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApi({
      baseUrl: '',
      getAuthHeaders: () => ({}),
      onUnauthorized: () => {},
      parseResponse: () => 'should not be called',
    });

    const out = await api.del('/v1/account/api-keys/abc');
    expect(out).toBeNull();
  });

  it('throws ApiError(network_error) when fetch rejects', async () => {
    globalThis.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const api = createApi({
      baseUrl: '',
      getAuthHeaders: () => ({}),
      onUnauthorized: () => {},
      parseResponse: (_m, _p, b) => b,
    });
    try {
      await api.get('/v1/account');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.code).toBe('network_error');
    }
  });
});
