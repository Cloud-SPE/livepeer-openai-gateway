import { LitElement, css, html } from 'lit';

// Shadow DOM here (not light DOM). Two reasons:
//   1. <slot> + <slot name="actions"> need real shadow-DOM projection so that
//      the consumer's content lands INSIDE the <dialog> element. In light
//      DOM <slot> is inert and content stays outside the modal — when
//      dialog.showModal() runs, the rest of the page becomes inert and the
//      consumer's buttons are unclickable.
//   2. The native <dialog>'s top-layer + ::backdrop semantics interact better
//      with shadow-DOM scoping.
// CSS custom properties cross the shadow boundary, so the global token
// catalogue still drives this component.

export class BridgeDialog extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    heading: { type: String },
    closeOnBackdrop: { type: Boolean, attribute: 'close-on-backdrop' },
  };

  static styles = css`
    :host {
      display: contents;
    }
    dialog {
      background: var(--surface-1);
      color: var(--text-1);
      border: 1px solid var(--border-1);
      border-radius: var(--radius-lg);
      padding: var(--space-6);
      max-width: min(32rem, 92vw);
      box-shadow: var(--shadow-lg);
      font-family: inherit;
      transition:
        opacity var(--duration-base) var(--ease-standard),
        translate var(--duration-base) var(--ease-standard),
        overlay var(--duration-base) var(--ease-standard) allow-discrete,
        display var(--duration-base) var(--ease-standard) allow-discrete;
    }
    dialog[open] {
      opacity: 1;
      translate: 0 0;
    }
    dialog:not([open]) {
      opacity: 0;
      translate: 0 -8px;
    }
    @starting-style {
      dialog[open] {
        opacity: 0;
        translate: 0 -8px;
      }
    }
    dialog::backdrop {
      background: color-mix(in oklch, black, transparent 50%);
      backdrop-filter: blur(2px);
    }
    header {
      margin-bottom: var(--space-4);
    }
    header h2 {
      font-size: var(--font-size-xl);
      margin: 0;
    }
    footer {
      display: flex;
      gap: var(--space-3);
      justify-content: flex-end;
      margin-top: var(--space-5);
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.heading = '';
    this.closeOnBackdrop = true;
  }

  updated(changed) {
    if (!changed.has('open')) return;
    const dialog = this.renderRoot.querySelector('dialog');
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
    // Click on the dialog element itself (not its children) = backdrop click
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
