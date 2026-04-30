/**
 * Generic sessionStorage helpers with key namespacing and JSON wrap.
 * Each consumer creates a namespaced session via createSession('bridge.portal').
 */

/**
 * @param {string} namespace e.g. 'bridge.portal' or 'bridge.admin'
 */
export function createSession(namespace) {
  const key = `${namespace}.session`;
  return {
    get() {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    /** @param {unknown} value */
    set(value) {
      try {
        sessionStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* quota / disabled — surface elsewhere if needed */
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* noop */
      }
    },
    has() {
      try {
        return sessionStorage.getItem(key) !== null;
      } catch {
        return false;
      }
    },
  };
}
