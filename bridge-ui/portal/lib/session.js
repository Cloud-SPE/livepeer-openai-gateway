import { createSession } from '../../shared/lib/session-storage.js';

export const session = createSession('bridge.portal');

/** Session shape: { apiKey: string, customerEmail?: string } */

export function getApiKey() {
  const s = session.get();
  return (s && typeof s === 'object' && typeof s.apiKey === 'string') ? s.apiKey : null;
}
