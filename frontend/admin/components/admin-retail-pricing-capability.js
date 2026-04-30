import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { retailPricingService } from '../lib/services/retailPricing.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';
import { matchesOf } from '../lib/glob.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-dialog.js';
import '../../shared/components/bridge-confirm-dialog.js';

const UNITS = {
  chat: 'token',
  embeddings: 'token',
  images: 'image',
  speech: 'character',
  transcriptions: 'minute',
};

const LABELS = {
  chat: 'Chat',
  embeddings: 'Embeddings',
  images: 'Images',
  speech: 'Speech',
  transcriptions: 'Transcriptions',
};

export class AdminRetailPricingCapability extends LitElement {
  static properties = {
    capability: { type: String },
    _busy: { state: true },
    _priceOpen: { state: true },
    _aliasOpen: { state: true },
    _priceForm: { state: true },
    _aliasForm: { state: true },
    _err: { state: true },
    _deletePriceId: { state: true },
    _deleteAliasId: { state: true },
  };

  constructor() {
    super();
    this.capability = 'chat';
    this._busy = false;
    this._priceOpen = false;
    this._aliasOpen = false;
    this._priceForm = this._emptyPriceForm();
    this._aliasForm = this._emptyAliasForm();
    this._err = '';
    this._deletePriceId = null;
    this._deleteAliasId = null;
  }

  willUpdate(changed) {
    if (changed.has('capability')) {
      this.prices = new ObservableController(this, retailPricingService.prices$(this.capability));
      this.aliases = new ObservableController(this, retailPricingService.aliases$(this.capability));
      this._priceForm = this._emptyPriceForm();
      this._aliasForm = this._emptyAliasForm();
    }
  }

  createRenderRoot() {
    return this;
  }

  async connectedCallback() {
    super.connectedCallback();
    await this._refresh();
  }

  async updated(changed) {
    if (changed.has('capability')) await this._refresh();
  }

  async _refresh() {
    await Promise.all([
      retailPricingService
        .fetchPrices(this.capability)
        .catch((e) => showToast({ kind: 'error', message: e.message })),
      retailPricingService
        .fetchAliases(this.capability)
        .catch((e) => showToast({ kind: 'error', message: e.message })),
    ]);
  }

  render() {
    const prices = this.prices?.value?.entries ?? null;
    const aliases = this.aliases?.value?.entries ?? null;
    return html`
      <section style="margin-bottom: var(--space-5);">
        <div
          style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-3);"
        >
          <div>
            <h2 style="margin:0 0 var(--space-1);">${LABELS[this.capability]} retail prices</h2>
            <p class="muted text-sm" style="margin:0;">
              Shell-native v3 pricing keyed by offering and customer tier.
              ${this.capability === 'chat'
                ? 'The current runtime still consumes a compatibility adapter built from prepaid input/output rows.'
                : 'The current runtime consumes the prepaid view through the compatibility adapter.'}
            </p>
          </div>
          <bridge-button @click=${() => this._openPrice()}>+ Add price</bridge-button>
        </div>
        ${prices === null
          ? html`<bridge-spinner></bridge-spinner>`
          : html`<bridge-table .columns=${this._priceColumns()} .rows=${prices}></bridge-table>`}
      </section>

      <section>
        <div
          style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-3);"
        >
          <div>
            <h2 style="margin:0 0 var(--space-1);">${LABELS[this.capability]} request aliases</h2>
            <p class="muted text-sm" style="margin:0;">
              Temporary mapping from today’s OpenAI request selectors to an offering.
            </p>
          </div>
          <bridge-button @click=${() => this._openAlias()}>+ Add alias</bridge-button>
        </div>
        ${aliases === null
          ? html`<bridge-spinner></bridge-spinner>`
          : html`
              <bridge-table
                .columns=${this._aliasColumns()}
                .rows=${aliases}
                empty="No aliases yet."
              ></bridge-table>
            `}
      </section>

      ${this._renderPriceDialog()} ${this._renderAliasDialog()} ${this._renderDeleteDialogs()}
    `;
  }

  _priceColumns() {
    return [
      { field: 'offering', header: 'Offering', render: (r) => r.offering },
      { field: 'customer_tier', header: 'Tier', render: (r) => r.customer_tier },
      { field: 'price_kind', header: 'Kind', render: (r) => r.price_kind },
      { field: 'unit', header: 'Unit', render: (r) => r.unit },
      {
        field: 'usd_per_unit',
        header: 'USD / unit',
        render: (r) => Number(r.usd_per_unit).toFixed(8),
      },
      {
        field: 'actions',
        header: '',
        render: (r) =>
          html`<bridge-button variant="ghost" @click=${() => (this._deletePriceId = r.id)}
            >Delete</bridge-button
          >`,
      },
    ];
  }

  _aliasColumns() {
    return [
      {
        field: 'model_or_pattern',
        header: 'Selector',
        render: (r) =>
          html`${r.model_or_pattern}${r.is_pattern ? html` <span class="muted">(glob)</span>` : ''}`,
      },
      { field: 'offering', header: 'Offering', render: (r) => r.offering },
      {
        field: 'variant',
        header: this.capability === 'images' ? 'Variant' : 'Sort',
        render: (r) =>
          this.capability === 'images'
            ? `${r.size || '—'} / ${r.quality || '—'}`
            : r.is_pattern
              ? r.sort_order
              : '—',
      },
      {
        field: 'actions',
        header: '',
        render: (r) =>
          html`<bridge-button variant="ghost" @click=${() => (this._deleteAliasId = r.id)}
            >Delete</bridge-button
          >`,
      },
    ];
  }

  _renderPriceDialog() {
    return html`
      <bridge-dialog
        ?open=${this._priceOpen}
        heading=${`Add ${LABELS[this.capability]} retail price`}
        @bridge-close=${() => this._closePrice()}
      >
        <div style="display:grid; gap: var(--space-3);">
          <label>
            Offering
            <input
              type="text"
              maxlength="256"
              style="width:100%"
              .value=${this._priceForm.offering}
              @input=${(e) => this._setPrice('offering', e.target.value)}
            />
          </label>
          <label>
            Customer tier
            <select
              .value=${this._priceForm.customer_tier}
              style="width:100%"
              @change=${(e) => this._setPrice('customer_tier', e.target.value)}
            >
              <option value="free">free</option>
              <option value="prepaid">prepaid</option>
            </select>
          </label>
          ${this.capability === 'chat'
            ? html`<label>
                Price kind
                <select
                  .value=${this._priceForm.price_kind}
                  style="width:100%"
                  @change=${(e) => this._setPrice('price_kind', e.target.value)}
                >
                  <option value="input">input</option>
                  <option value="output">output</option>
                </select>
              </label>`
            : ''}
          <label>
            Unit
            <input
              type="text"
              style="width:100%"
              .value=${this._priceForm.unit}
              @input=${(e) => this._setPrice('unit', e.target.value)}
            />
          </label>
          <label>
            USD per unit
            <input
              type="text"
              inputmode="decimal"
              style="width:100%"
              .value=${this._priceForm.usd_per_unit}
              @input=${(e) => this._setPrice('usd_per_unit', e.target.value)}
            />
          </label>
          ${this._err ? html`<p class="error text-sm" role="alert">${this._err}</p>` : ''}
        </div>
        <div slot="actions">
          <bridge-button variant="ghost" @click=${() => this._closePrice()}>Cancel</bridge-button>
          <bridge-button @click=${this._submitPrice} ?loading=${this._busy}>Add</bridge-button>
        </div>
      </bridge-dialog>
    `;
  }

  _renderAliasDialog() {
    return html`
      <bridge-dialog
        ?open=${this._aliasOpen}
        heading=${`Add ${LABELS[this.capability]} alias`}
        @bridge-close=${() => this._closeAlias()}
      >
        <div style="display:grid; gap: var(--space-3);">
          <label>
            Type
            <select
              .value=${this._aliasForm.is_pattern ? 'pattern' : 'exact'}
              style="width:100%"
              @change=${(e) => this._setAlias('is_pattern', e.target.value === 'pattern')}
            >
              <option value="exact">Exact</option>
              <option value="pattern">Glob pattern</option>
            </select>
          </label>
          <label>
            ${this._aliasForm.is_pattern ? 'Pattern' : 'Model'}
            <input
              type="text"
              maxlength="256"
              style="width:100%"
              .value=${this._aliasForm.model_or_pattern}
              @input=${(e) => this._setAlias('model_or_pattern', e.target.value)}
            />
            ${this._aliasForm.is_pattern && this._aliasForm.model_or_pattern
              ? html`<p class="muted text-sm" style="margin: var(--space-1) 0 0;">
                  ${this._preview()}
                </p>`
              : ''}
          </label>
          <label>
            Offering
            <input
              type="text"
              maxlength="256"
              style="width:100%"
              .value=${this._aliasForm.offering}
              @input=${(e) => this._setAlias('offering', e.target.value)}
            />
          </label>
          ${this.capability === 'images'
            ? html`
                <label>
                  Size
                  <select
                    .value=${this._aliasForm.size}
                    style="width:100%"
                    @change=${(e) => this._setAlias('size', e.target.value)}
                  >
                    <option value="1024x1024">1024x1024</option>
                    <option value="1024x1792">1024x1792</option>
                    <option value="1792x1024">1792x1024</option>
                  </select>
                </label>
                <label>
                  Quality
                  <select
                    .value=${this._aliasForm.quality}
                    style="width:100%"
                    @change=${(e) => this._setAlias('quality', e.target.value)}
                  >
                    <option value="standard">standard</option>
                    <option value="hd">hd</option>
                  </select>
                </label>
              `
            : ''}
          ${this._aliasForm.is_pattern
            ? html`<label>
                Sort order
                <input
                  type="number"
                  min="0"
                  max="10000"
                  style="width:100%"
                  .value=${this._aliasForm.sort_order}
                  @input=${(e) => this._setAlias('sort_order', e.target.value)}
                />
              </label>`
            : ''}
          ${this._err ? html`<p class="error text-sm" role="alert">${this._err}</p>` : ''}
        </div>
        <div slot="actions">
          <bridge-button variant="ghost" @click=${() => this._closeAlias()}>Cancel</bridge-button>
          <bridge-button @click=${this._submitAlias} ?loading=${this._busy}>Add</bridge-button>
        </div>
      </bridge-dialog>
    `;
  }

  _renderDeleteDialogs() {
    return html`
      <bridge-confirm-dialog
        ?open=${this._deletePriceId !== null}
        heading="Delete retail price?"
        body="This removes one retail price row."
        confirm-label="Delete"
        cancel-label="Cancel"
        danger
        ?loading=${this._busy}
        @bridge-confirm=${this._confirmDeletePrice}
        @bridge-cancel=${() => (this._deletePriceId = null)}
        @bridge-close=${() => (this._deletePriceId = null)}
      ></bridge-confirm-dialog>
      <bridge-confirm-dialog
        ?open=${this._deleteAliasId !== null}
        heading="Delete alias?"
        body="This removes one request-to-offering alias."
        confirm-label="Delete"
        cancel-label="Cancel"
        danger
        ?loading=${this._busy}
        @bridge-confirm=${this._confirmDeleteAlias}
        @bridge-cancel=${() => (this._deleteAliasId = null)}
        @bridge-close=${() => (this._deleteAliasId = null)}
      ></bridge-confirm-dialog>
    `;
  }

  _emptyPriceForm() {
    return {
      capability: this.capability,
      offering: '',
      customer_tier: 'prepaid',
      price_kind: this.capability === 'chat' ? 'input' : 'default',
      unit: UNITS[this.capability] ?? 'unit',
      usd_per_unit: '',
    };
  }

  _emptyAliasForm() {
    return {
      capability: this.capability,
      model_or_pattern: '',
      is_pattern: false,
      offering: '',
      size: this.capability === 'images' ? '1024x1024' : '',
      quality: this.capability === 'images' ? 'standard' : '',
      sort_order: 100,
    };
  }

  _openPrice() {
    this._priceForm = this._emptyPriceForm();
    this._err = '';
    this._priceOpen = true;
  }
  _closePrice() {
    if (!this._busy) this._priceOpen = false;
  }
  _openAlias() {
    this._aliasForm = this._emptyAliasForm();
    this._err = '';
    this._aliasOpen = true;
  }
  _closeAlias() {
    if (!this._busy) this._aliasOpen = false;
  }
  _setPrice(key, value) {
    this._priceForm = { ...this._priceForm, [key]: value };
  }
  _setAlias(key, value) {
    this._aliasForm = { ...this._aliasForm, [key]: value };
  }

  _preview() {
    const candidates = (this.aliases.value?.entries ?? [])
      .filter((entry) => !entry.is_pattern)
      .map((entry) => entry.model_or_pattern);
    const matched = matchesOf(this._aliasForm.model_or_pattern, candidates);
    return matched.length === 0
      ? 'No exact aliases match yet.'
      : `Matches ${matched.length}: ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? '…' : ''}`;
  }

  _submitPrice = async () => {
    if (!this._priceForm.offering.trim()) {
      this._err = 'Offering is required.';
      return;
    }
    if (!this._priceForm.usd_per_unit.toString().trim()) {
      this._err = 'USD per unit is required.';
      return;
    }
    this._busy = true;
    this._err = '';
    try {
      await retailPricingService.createPrice({
        ...this._priceForm,
        capability: this.capability,
        offering: this._priceForm.offering.trim(),
      });
      this._priceOpen = false;
      showToast({ kind: 'success', message: 'Retail price added.' });
    } catch (err) {
      this._err = err?.message ?? 'Failed.';
    } finally {
      this._busy = false;
    }
  };

  _submitAlias = async () => {
    if (!this._aliasForm.model_or_pattern.trim() || !this._aliasForm.offering.trim()) {
      this._err = 'Model / pattern and offering are required.';
      return;
    }
    this._busy = true;
    this._err = '';
    try {
      const body = {
        ...this._aliasForm,
        capability: this.capability,
        model_or_pattern: this._aliasForm.model_or_pattern.trim(),
        offering: this._aliasForm.offering.trim(),
      };
      if (!body.is_pattern) delete body.sort_order;
      await retailPricingService.createAlias(body);
      this._aliasOpen = false;
      showToast({ kind: 'success', message: 'Alias added.' });
    } catch (err) {
      this._err = err?.message ?? 'Failed.';
    } finally {
      this._busy = false;
    }
  };

  _confirmDeletePrice = async () => {
    if (!this._deletePriceId) return;
    this._busy = true;
    try {
      await retailPricingService.deletePrice(this.capability, this._deletePriceId);
      showToast({ kind: 'success', message: 'Retail price deleted.' });
    } catch (err) {
      showToast({ kind: 'error', message: err?.message ?? 'Delete failed.' });
    } finally {
      this._busy = false;
      this._deletePriceId = null;
    }
  };

  _confirmDeleteAlias = async () => {
    if (!this._deleteAliasId) return;
    this._busy = true;
    try {
      await retailPricingService.deleteAlias(this.capability, this._deleteAliasId);
      showToast({ kind: 'success', message: 'Alias deleted.' });
    } catch (err) {
      showToast({ kind: 'error', message: err?.message ?? 'Delete failed.' });
    } finally {
      this._busy = false;
      this._deleteAliasId = null;
    }
  };
}

if (!customElements.get('admin-retail-pricing-capability')) {
  customElements.define('admin-retail-pricing-capability', AdminRetailPricingCapability);
}
