/**
 * createApi — fetch-wrapper factory. Each consumer wraps with its own auth
 * strategy and response-validator dispatcher.
 *
 * @param {{
 *   baseUrl: string,
 *   getAuthHeaders: () => Record<string, string>,
 *   onUnauthorized: () => void,
 *   parseResponse: (method: string, path: string, body: unknown) => unknown,
 * }} cfg
 */
export function createApi(cfg) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    const url = `${cfg.baseUrl}${path}`;
    const init = {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...cfg.getAuthHeaders(),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new ApiError('network_error', 0, err instanceof Error ? err.message : 'fetch failed');
    }

    if (res.status === 401) {
      cfg.onUnauthorized();
      throw new ApiError('unauthorized', 401, 'unauthorized');
    }
    if (res.status === 204) return null;

    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const payload = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const message = payload && typeof payload === 'object' && 'error' in payload
        ? extractErrorMessage(payload.error)
        : `http_${res.status}`;
      throw new ApiError('http_error', res.status, message, payload);
    }

    return cfg.parseResponse(method, path, payload);
  }

  return {
    request,
    /** @param {string} path */
    get(path) { return request('GET', path); },
    /** @param {string} path @param {unknown} body */
    post(path, body) { return request('POST', path, body); },
    /** @param {string} path @param {unknown} body */
    put(path, body) { return request('PUT', path, body); },
    /** @param {string} path */
    del(path) { return request('DELETE', path); },
  };
}

export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string} message
   * @param {unknown} [body]
   */
  constructor(code, status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function extractErrorMessage(err) {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return 'request_failed';
}
