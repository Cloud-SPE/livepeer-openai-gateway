/**
 * Hash-based routing helpers. Consumers maintain their own allowlist and
 * call resolveRoute() on hashchange. View Transitions wrap the swap when
 * supported (graceful fallthrough otherwise).
 */
import { BRIDGE_EVENTS, emit } from './events.js';

/**
 * @param {string[]} allowlist  exact match views (e.g. ['dashboard', 'keys'])
 * @param {string} fallback     view to use when hash is empty or unknown
 * @returns {string}            resolved view name
 */
export function resolveRoute(allowlist, fallback) {
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  const head = raw.split('/')[0] || '';
  return allowlist.includes(head) ? head : fallback;
}

/**
 * Run `update()` inside a View Transition when the API is available.
 * @param {() => void | Promise<void>} update
 */
export async function withViewTransition(update) {
  if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
    const t = document.startViewTransition(() => update());
    // Both `ready` and `finished` reject with AbortError when a transition is
    // interrupted. Swallow both so they don't surface as unhandled rejections.
    t.ready.catch(() => {});
    try {
      await t.finished;
    } catch {
      /* skipped */
    }
    return;
  }
  await update();
}

/**
 * Subscribe to hashchange events. Calls handler with the new hash (without #).
 * @param {(hash: string) => void} handler
 */
export function onHashChange(handler) {
  const listener = () => {
    const hash = location.hash.replace(/^#/, '');
    handler(hash);
    emit(BRIDGE_EVENTS.ROUTE_CHANGE, hash);
  };
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/** @param {string} view */
export function navigate(view) {
  location.hash = `#${view}`;
}
