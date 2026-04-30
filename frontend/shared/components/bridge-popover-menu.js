import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';

const STYLES = `
@layer components {
  bridge-popover-menu { position: relative; display: inline-block; }
  bridge-popover-menu [popover] {
    position: absolute;
    inset: auto;
    margin: 0;
    padding: var(--space-1);
    background: var(--surface-2);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    min-width: 12rem;
  }
  bridge-popover-menu [popover]::backdrop { background: transparent; }
  bridge-popover-menu .item {
    display: block;
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    color: var(--text-1);
  }
  bridge-popover-menu .item:hover { background: var(--surface-3); }
  bridge-popover-menu .item[data-danger] { color: var(--danger); }
}
`;

/**
 * Lightweight popover menu using the native Popover API. Items are passed
 * via the `items` property: `[{ label, value, danger? }]`. Dispatches
 * `bridge-select` with `detail.value` on choice.
 */
export class BridgePopoverMenu extends LitElement {
  static properties = {
    items: { type: Array },
    label: { type: String },
  };

  constructor() {
    super();
    this.items = [];
    this.label = 'Actions';
    this._popoverId = `bp-${Math.random().toString(36).slice(2, 8)}`;
    adoptStyles('bridge-popover-menu', STYLES);
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <bridge-button variant="ghost" popovertarget=${this._popoverId}>${this.label}</bridge-button>
      <div id=${this._popoverId} popover>
        ${this.items.map(
          (it) => html`
            <button class="item" ?data-danger=${it.danger} @click=${() => this._select(it.value)}>
              ${it.label}
            </button>
          `,
        )}
      </div>
    `;
  }

  _select(value) {
    const popover = this.querySelector('[popover]');
    if (popover && typeof popover.hidePopover === 'function') popover.hidePopover();
    this.dispatchEvent(new CustomEvent('bridge-select', { detail: { value } }));
  }
}

if (!customElements.get('bridge-popover-menu')) {
  customElements.define('bridge-popover-menu', BridgePopoverMenu);
}
