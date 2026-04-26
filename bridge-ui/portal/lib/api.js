import { createApi } from '../../shared/lib/api-base.js';
import { BRIDGE_EVENTS, emit } from '../../shared/lib/events.js';
import { getApiKey, session } from './session.js';
import { parseResponse } from './schemas.js';

/** API singleton — used by services. Auth strategy: Bearer <apiKey>. */
export const api = createApi({
  baseUrl: '',
  getAuthHeaders() {
    const key = getApiKey();
    return key ? { authorization: `Bearer ${key}` } : {};
  },
  onUnauthorized() {
    session.clear();
    emit(BRIDGE_EVENTS.UNAUTHORIZED);
  },
  parseResponse,
});

/**
 * Sign-in: validate a pasted API key by calling GET /v1/account with it as
 * the Bearer token. Stores the session on success and returns the account.
 * Throws ApiError on failure.
 *
 * @param {string} apiKey
 */
export async function signIn(apiKey) {
  const res = await fetch('/v1/account', {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `http_${res.status}`;
    throw new Error(message);
  }
  const account = parseResponse('GET', '/v1/account', await res.json());
  session.set({ apiKey, customerEmail: account.email });
  return account;
}
