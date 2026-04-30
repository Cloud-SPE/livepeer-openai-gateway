import { createSession } from '../../shared/lib/session-storage.js';

export const session = createSession('bridge.admin');

/** Session shape: { token: string, actor: string } */

export function getToken() {
  const s = session.get();
  return s && typeof s === 'object' && typeof s.token === 'string' ? s.token : null;
}

export function getActor() {
  const s = session.get();
  return s && typeof s === 'object' && typeof s.actor === 'string' ? s.actor : null;
}
