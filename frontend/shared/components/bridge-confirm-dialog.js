import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';
import './bridge-dialog.js';
import './bridge-button.js';

const STYLES = `
@layer components {
  bridge-confirm-dialog .body { color: var(--text-2); margin: 0 0 var(--space-4); }
  bridge-confirm-dialog .type-prompt {
    font-size: var(--font-size-sm);
    color: var(--text-3);
    margin: var(--space-3) 0 var(--space-2);
  }
  bridge-confirm-dialog .type-prompt code { color: var(--text-1); }
  bridge-confirm-dialog input.confirm-input {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
  }
}
`;

/**
 * Generic confirm dialog. Two modes:
 *  - Single-click: omit type-to-confirm or set requiredText to empty.
 *  - Type-to-confirm: pass `requiredText` (e.g. customer email). Confirm
 *    button disabled until input matches exactly.
 *
 * Events: `bridge-confirm` (confirmed), `bridge-cancel`, `bridge-close`.
 */
export class BridgeConfirmDialog extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    heading: { type: String },
    body: { type: String },
    confirmLabel: { type: String, attribute: 'confirm-label' },
    cancelLabel: { type: String, attribute: 'cancel-label' },
    danger: { type: Boolean, reflect: true },
    requiredText: { type: String, attribute: 'required-text' },
    loading: { type: Boolean, reflect: true },
    _typed: { state: true },
  };

  constructor() {
    super();
    this.open = false;
    this.heading = 'Are you sure?';
    this.body = '';
    this.confirmLabel = 'Confirm';
    this.cancelLabel = 'Cancel';
    this.danger = false;
    this.requiredText = '';
    this.loading = false;
    this._typed = '';
    adoptStyles('bridge-confirm-dialog', STYLES);
  }

  createRenderRoot() {
    return this;
  }

  willUpdate(changed) {
    if (changed.has('open') && this.open) this._typed = '';
  }

  get _confirmEnabled() {
    if (this.loading) return false;
    if (!this.requiredText) return true;
    return this._typed === this.requiredText;
  }

  render() {
    return html`
      <bridge-dialog
        ?open=${this.open}
        heading=${this.heading}
        @bridge-close=${this._onClose}
        close-on-backdrop
      >
        ${this.body ? html`<p class="body">${this.body}</p>` : ''}
        ${this.requiredText
          ? html`
              <p class="type-prompt">Type <code>${this.requiredText}</code> to confirm:</p>
              <input
                class="confirm-input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                .value=${this._typed}
                @input=${(e) => {
                  this._typed = e.target.value;
                }}
              />
            `
          : ''}
        <div slot="actions">
          <bridge-button variant="ghost" @click=${this._cancel}>${this.cancelLabel}</bridge-button>
          <bridge-button
            variant=${this.danger ? 'danger' : 'primary'}
            ?disabled=${!this._confirmEnabled}
            ?loading=${this.loading}
            @click=${this._confirm}
            >${this.confirmLabel}</bridge-button
          >
        </div>
      </bridge-dialog>
    `;
  }

  _confirm() {
    if (!this._confirmEnabled) return;
    this.dispatchEvent(new CustomEvent('bridge-confirm'));
  }

  _cancel() {
    this.dispatchEvent(new CustomEvent('bridge-cancel'));
    this.open = false;
  }

  _onClose() {
    this.open = false;
    this.dispatchEvent(new CustomEvent('bridge-close'));
  }
}

if (!customElements.get('bridge-confirm-dialog')) {
  customElements.define('bridge-confirm-dialog', BridgeConfirmDialog);
}
