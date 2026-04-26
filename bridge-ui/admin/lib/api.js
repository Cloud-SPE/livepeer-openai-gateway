import { createApi } from '../../shared/lib/api-base.js';
import { BRIDGE_EVENTS, emit } from '../../shared/lib/events.js';
import { getActor, getToken, session } from './session.js';
import { parseResponse } from './schemas.js';

/**
 * Admin API singleton. Auth strategy: X-Admin-Token + (optional) X-Admin-Actor
 * — distinct from the portal's Bearer-key strategy. This validates that
 * shared/lib/api-base.js's createApi factory accepts arbitrary header
 * strategies via the getAuthHeaders callback.
 */
export const api = createApi({
  baseUrl: '',
  getAuthHeaders() {
    const headers = {};
    const token = getToken();
    const actor = getActor();
    if (token) headers['x-admin-token'] = token;
    if (actor) headers['x-admin-actor'] = actor;
    return headers;
  },
  onUnauthorized() {
    session.clear();
    emit(BRIDGE_EVENTS.UNAUTHORIZED);
  },
  parseResponse,
});

/**
 * Sign-in: validate the admin token + actor by hitting GET /admin/health.
 * On success stores the session.
 *
 * @param {string} token
 * @param {string} actor
 */
export async function signIn(token, actor) {
  if (!/^[a-z0-9._-]{1,64}$/.test(actor)) {
    throw new Error('actor must match ^[a-z0-9._-]{1,64}$');
  }
  const res = await fetch('/admin/health', {
    headers: {
      'x-admin-token': token,
      'x-admin-actor': actor,
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `http_${res.status}`);
  }
  session.set({ token, actor });
  return parseResponse('GET', '/admin/health', await res.json());
}
