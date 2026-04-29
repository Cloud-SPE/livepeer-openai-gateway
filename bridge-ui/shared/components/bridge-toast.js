import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';
import { BRIDGE_EVENTS, on } from '../lib/events.js';

const STYLES = `
@layer components {
  bridge-toast-stack {
    position: fixed;
    inset-block-end: var(--space-5);
    inset-inline-end: var(--space-5);
    display: grid;
    gap: var(--space-2);
    z-index: 1000;
    max-width: min(28rem, 92vw);
    pointer-events: none;
  }
  bridge-toast-stack .toast {
    background: var(--surface-2);
    color: var(--text-1);
    border: 1px solid var(--border-1);
    border-left-width: 4px;
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    box-shadow: var(--shadow-md);
    pointer-events: auto;
    transition: opacity var(--duration-base) var(--ease-standard),
                translate var(--duration-base) var(--ease-standard);
  }
  bridge-toast-stack .toast[data-kind='error'] { border-left-color: var(--danger); }
  bridge-toast-stack .toast[data-kind='warning'] { border-left-color: var(--warning); }
  bridge-toast-stack .toast[data-kind='success'] { border-left-color: var(--success); }
  bridge-toast-stack .toast[data-kind='info'] { border-left-color: var(--accent); }
  bridge-toast-stack .toast.entering { opacity: 0; translate: 0 8px; }
  @starting-style {
    bridge-toast-stack .toast { opacity: 0; translate: 0 8px; }
  }
}
`;

/**
 * <bridge-toast-stack> mounts once per app shell and listens for
 * `bridge:toast` window events with detail = { kind, message, ttlMs? }.
 *
 * Convenience emitter:
 *   import { showToast } from '.../bridge-toast.js';
 *   showToast({ kind: 'error', message: 'Something failed' });
 */
export class BridgeToastStack extends LitElement {
  static properties = { _toasts: { state: true } };

  constructor() {
    super();
    this._toasts = [];
    this._nextId = 1;
    this._unsub = null;
    adoptStyles('bridge-toast-stack', STYLES);
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this._unsub = on(BRIDGE_EVENTS.TOAST, (detail) => {
      if (!detail || typeof detail !== 'object') return;
      this._push(detail);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsub) this._unsub();
  }

  _push({ kind = 'info', message = '', ttlMs = 5000 }) {
    const id = this._nextId++;
    this._toasts = [...this._toasts, { id, kind, message }];
    if (ttlMs > 0) {
      setTimeout(() => {
        this._toasts = this._toasts.filter((t) => t.id !== id);
      }, ttlMs);
    }
  }

  render() {
    return html`
      ${this._toasts.map(
        (t) => html` <div class="toast" data-kind=${t.kind} role="status">${t.message}</div> `,
      )}
    `;
  }
}

if (!customElements.get('bridge-toast-stack')) {
  customElements.define('bridge-toast-stack', BridgeToastStack);
}

/** @param {{ kind?: 'info'|'success'|'warning'|'error', message: string, ttlMs?: number }} detail */
export function showToast(detail) {
  window.dispatchEvent(new CustomEvent(BRIDGE_EVENTS.TOAST, { detail }));
}
