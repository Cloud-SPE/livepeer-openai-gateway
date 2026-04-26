import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';

const STYLES = `
@layer components {
  bridge-button {
    --_bg: var(--accent);
    --_bg-hover: var(--accent-hover);
    --_fg: white;
    display: inline-flex;
  }
  bridge-button[variant='ghost'] {
    --_bg: transparent;
    --_bg-hover: var(--surface-2);
    --_fg: var(--text-1);
  }
  bridge-button[variant='danger'] {
    --_bg: var(--danger);
    --_bg-hover: var(--danger-hover);
    --_fg: white;
  }
  bridge-button[block] { display: flex; width: 100%; }
  bridge-button button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--_bg);
    color: var(--_fg);
    font-weight: 600;
    font-size: var(--font-size-sm);
    border: 1px solid color-mix(in oklch, var(--_bg), black 8%);
    transition: background var(--duration-fast) var(--ease-standard),
                box-shadow var(--duration-fast) var(--ease-standard),
                transform var(--duration-fast) var(--ease-standard);
    width: 100%;

    &:hover:not(:disabled) { background: var(--_bg-hover); }
    &:active:not(:disabled) { transform: translateY(1px); }
    &:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--_bg), transparent 70%);
    }
    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  }
}
`;

export class BridgeButton extends LitElement {
  static properties = {
    variant: { type: String, reflect: true },
    block: { type: Boolean, reflect: true },
    type: { type: String },
    disabled: { type: Boolean, reflect: true },
    loading: { type: Boolean, reflect: true },
  };

  constructor() {
    super();
    this.variant = 'primary';
    this.block = false;
    this.type = 'button';
    this.disabled = false;
    this.loading = false;
    adoptStyles('bridge-button', STYLES);
  }

  createRenderRoot() { return this; }

  render() {
    return html`
      <button
        type=${this.type}
        ?disabled=${this.disabled || this.loading}
        @click=${this._onClick}
      >
        ${this.loading ? html`<bridge-spinner size="14"></bridge-spinner>` : ''}
        <slot></slot>
      </button>
    `;
  }

  _onClick(e) {
    if (this.disabled || this.loading) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

if (!customElements.get('bridge-button')) {
  customElements.define('bridge-button', BridgeButton);
}
