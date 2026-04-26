/**
 * bridge:-namespaced CustomEvent helpers. Use these instead of constructing
 * CustomEvents inline so event names stay consistent.
 */

export const BRIDGE_EVENTS = Object.freeze({
  AUTHENTICATED: 'bridge:authenticated',
  UNAUTHORIZED: 'bridge:unauthorized',
  ROUTE_CHANGE: 'bridge:routechange',
  TOAST: 'bridge:toast',
});

/** @param {string} name @param {unknown} [detail] */
export function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
}

/** @param {string} name @param {(detail: unknown) => void} handler */
export function on(name, handler) {
  const wrapped = (e) => handler(e instanceof CustomEvent ? e.detail : undefined);
  window.addEventListener(name, wrapped);
  return () => window.removeEventListener(name, wrapped);
}
