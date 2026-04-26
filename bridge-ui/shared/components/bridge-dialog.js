import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';

const STYLES = `
@layer components {
  bridge-dialog dialog {
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
    max-width: min(32rem, 92vw);
    box-shadow: var(--shadow-lg);
    transition: opacity var(--duration-base) var(--ease-standard),
                translate var(--duration-base) var(--ease-standard),
                overlay var(--duration-base) var(--ease-standard) allow-discrete,
                display var(--duration-base) var(--ease-standard) allow-discrete;
  }
  bridge-dialog dialog[open] { opacity: 1; translate: 0 0; }
  bridge-dialog dialog:not([open]) { opacity: 0; translate: 0 -8px; }
  @starting-style {
    bridge-dialog dialog[open] { opacity: 0; translate: 0 -8px; }
  }
  bridge-dialog header { margin-bottom: var(--space-4); }
  bridge-dialog header h2 {
    font-size: var(--font-size-xl);
    margin: 0;
  }
  bridge-dialog footer {
    display: flex;
    gap: var(--space-3);
    justify-content: flex-end;
    margin-top: var(--space-5);
  }
}
`;

export class BridgeDialog extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    heading: { type: String },
    closeOnBackdrop: { type: Boolean, attribute: 'close-on-backdrop' },
  };

  constructor() {
    super();
    this.open = false;
    this.heading = '';
    this.closeOnBackdrop = true;
    this._dialogRef = null;
    adoptStyles('bridge-dialog', STYLES);
  }

  createRenderRoot() { return this; }

  updated(changed) {
    if (!changed.has('open')) return;
    const dialog = this.querySelector('dialog');
    if (!dialog) return;
    if (this.open && !dialog.open) {
      dialog.showModal();
    } else if (!this.open && dialog.open) {
      dialog.close();
    }
  }

  render() {
    return html`
      <dialog @click=${this._onClick} @close=${this._onClose}>
        ${this.heading ? html`<header><h2>${this.heading}</h2></header>` : ''}
        <slot></slot>
        <footer><slot name="actions"></slot></footer>
      </dialog>
    `;
  }

  _onClick(e) {
    if (!this.closeOnBackdrop) return;
    // Click on the dialog element itself (not its children) = backdrop
    if (e.target instanceof HTMLDialogElement) this.close();
  }

  _onClose() {
    if (this.open) {
      this.open = false;
      this.dispatchEvent(new CustomEvent('bridge-close'));
    }
  }

  close() {
    this.open = false;
  }
}

if (!customElements.get('bridge-dialog')) {
  customElements.define('bridge-dialog', BridgeDialog);
}
