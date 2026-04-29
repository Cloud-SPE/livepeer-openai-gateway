import { LitElement, css, html } from 'lit';

// Shadow DOM here (not light DOM). bridge-button uses <slot> to project its
// children into the inner <button>; in light DOM, <slot> doesn't function and
// children render alongside the button instead of inside it. CSS custom
// properties (--surface-1, --accent, etc.) inherit through the shadow
// boundary, so the global token catalogue defined in shared/css/tokens.css
// still drives this component's color / spacing / typography.

export class BridgeButton extends LitElement {
  static properties = {
    variant: { type: String, reflect: true },
    block: { type: Boolean, reflect: true },
    type: { type: String },
    disabled: { type: Boolean, reflect: true },
    loading: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      --_bg: var(--accent);
      --_bg-hover: var(--accent-hover);
      --_fg: white;
      display: inline-flex;
    }
    :host([variant='ghost']) {
      --_bg: transparent;
      --_bg-hover: var(--surface-2);
      --_fg: var(--text-1);
    }
    :host([variant='danger']) {
      --_bg: var(--danger);
      --_bg-hover: var(--danger-hover);
      --_fg: white;
    }
    :host([block]) {
      display: flex;
      width: 100%;
    }
    button {
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
      font-family: inherit;
      border: 1px solid color-mix(in oklch, var(--_bg), black 8%);
      transition:
        background var(--duration-fast) var(--ease-standard),
        box-shadow var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard);
      width: 100%;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: var(--_bg-hover);
    }
    button:active:not(:disabled) {
      transform: translateY(1px);
    }
    button:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--_bg), transparent 70%);
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  `;

  constructor() {
    super();
    this.variant = 'primary';
    this.block = false;
    this.type = 'button';
    this.disabled = false;
    this.loading = false;
  }

  render() {
    return html`
      <button type=${this.type} ?disabled=${this.disabled || this.loading} @click=${this._onClick}>
        ${this.loading ? html`<bridge-spinner size="14"></bridge-spinner>` : ''}
        <slot></slot>
      </button>
    `;
  }

  _onClick(e) {
    if (this.disabled || this.loading) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Native form submission doesn't cross the shadow boundary: a
    // <button type="submit"> inside our shadow root won't trigger
    // form.submit on the light-DOM <form> ancestor of <bridge-button>.
    // Forward submit clicks manually so consumers can keep using
    // <form>...<bridge-button type="submit">...</bridge-button></form>.
    if (this.type === 'submit') {
      const form = this.closest('form');
      if (form) {
        e.preventDefault();
        form.requestSubmit();
      }
    }
  }
}

if (!customElements.get('bridge-button')) {
  customElements.define('bridge-button', BridgeButton);
}
