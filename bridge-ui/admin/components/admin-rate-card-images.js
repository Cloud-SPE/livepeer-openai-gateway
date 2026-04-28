import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { rateCardService } from '../lib/services/rateCard.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';
import { matchesOf } from '../lib/glob.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-dialog.js';
import '../../shared/components/bridge-confirm-dialog.js';

const SIZES = ['1024x1024', '1024x1792', '1792x1024'];
const QUALITIES = ['standard', 'hd'];

export class AdminRateCardImages extends LitElement {
  static properties = {
    _addOpen: { state: true }, _busy: { state: true }, _form: { state: true },
    _err: { state: true }, _deleteId: { state: true },
  };
  constructor() {
    super();
    this.entries = new ObservableController(this, rateCardService.images$);
    this._addOpen = false; this._busy = false; this._err = ''; this._deleteId = null;
    this._form = this._emptyForm();
  }
  createRenderRoot() { return this; }
  async connectedCallback() {
    super.connectedCallback();
    rateCardService.fetchImages().catch((e) => showToast({ kind: 'error', message: e.message }));
  }
  render() {
    const entries = this.entries.value?.entries ?? null;
    return html`
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-3);">
        <h2 style="margin:0;">Images — (model, size, quality) → USD per image</h2>
        <bridge-button @click=${() => this._openAdd()}>+ Add SKU / pattern</bridge-button>
      </div>
      ${entries === null ? html`<bridge-spinner></bridge-spinner>` : html`
        <bridge-table .columns=${this._cols()} .rows=${entries} empty="No entries."></bridge-table>
      `}
      <bridge-dialog ?open=${this._addOpen} heading="Add images entry" @bridge-close=${() => this._closeAdd()}>
        <div style="display:grid; gap: var(--space-3);">
          <label>Type
            <select .value=${this._form.is_pattern ? 'pattern' : 'exact'} @change=${(e) => this._set('is_pattern', e.target.value === 'pattern')} style="width:100%">
              <option value="exact">Exact model name</option>
              <option value="pattern">Glob pattern (model only — size/quality stay exact)</option>
            </select>
          </label>
          <label>${this._form.is_pattern ? 'Pattern' : 'Model'}
            <input type="text" maxlength="256" style="width:100%" .value=${this._form.model_or_pattern}
              placeholder=${this._form.is_pattern ? 'e.g. dall-e-*' : 'e.g. dall-e-3'}
              @input=${(e) => this._set('model_or_pattern', e.target.value)}/>
            ${this._form.is_pattern && this._form.model_or_pattern ? html`<p class="muted text-sm" style="margin: var(--space-1) 0 0;">${this._preview()}</p>` : ''}
          </label>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <label>Size
              <select .value=${this._form.size} @change=${(e) => this._set('size', e.target.value)} style="width:100%">
                ${SIZES.map((s) => html`<option value=${s}>${s}</option>`)}
              </select>
            </label>
            <label>Quality
              <select .value=${this._form.quality} @change=${(e) => this._set('quality', e.target.value)} style="width:100%">
                ${QUALITIES.map((q) => html`<option value=${q}>${q}</option>`)}
              </select>
            </label>
          </div>
          <label>USD per image
            <input type="text" inputmode="decimal" style="width:100%" .value=${this._form.usd_per_image}
              @input=${(e) => this._set('usd_per_image', e.target.value)}/>
          </label>
          ${this._form.is_pattern ? html`<label>Sort order<input type="number" min="0" max="10000" style="width:100%" .value=${this._form.sort_order} @input=${(e) => this._set('sort_order', e.target.value)}/></label>` : ''}
          ${this._err ? html`<p class="error text-sm" role="alert">${this._err}</p>` : ''}
        </div>
        <div slot="actions">
          <bridge-button variant="ghost" @click=${() => this._closeAdd()}>Cancel</bridge-button>
          <bridge-button @click=${this._submitAdd} ?loading=${this._busy}>Add</bridge-button>
        </div>
      </bridge-dialog>
      <bridge-confirm-dialog ?open=${this._deleteId !== null}
        heading="Delete entry?" body="Customers requesting this (model, size, quality) will get model_not_found until you re-add it."
        confirm-label="Delete" cancel-label="Cancel" danger ?loading=${this._busy}
        @bridge-confirm=${this._confirmDelete}
        @bridge-cancel=${() => { this._deleteId = null; }}
        @bridge-close=${() => { this._deleteId = null; }}></bridge-confirm-dialog>
    `;
  }
  _cols() {
    return [
      { field: 'model_or_pattern', header: 'Model / Pattern', render: (r) => html`${r.model_or_pattern}${r.is_pattern ? html` <span class="muted">(glob)</span>` : ''}` },
      { field: 'size', header: 'Size', render: (r) => r.size },
      { field: 'quality', header: 'Quality', render: (r) => r.quality },
      { field: 'usd_per_image', header: '$/image', render: (r) => Number(r.usd_per_image).toFixed(4) },
      { field: 'sort_order', header: 'Sort', render: (r) => r.is_pattern ? r.sort_order : '—' },
      { field: 'actions', header: '', render: (r) => html`<bridge-button variant="ghost" @click=${() => { this._deleteId = r.id; }}>Delete</bridge-button>` },
    ];
  }
  _emptyForm() { return { model_or_pattern: '', is_pattern: false, size: '1024x1024', quality: 'standard', usd_per_image: '', sort_order: 100 }; }
  _openAdd() { this._form = this._emptyForm(); this._err = ''; this._addOpen = true; }
  _closeAdd() { if (!this._busy) this._addOpen = false; }
  _set(k, v) { this._form = { ...this._form, [k]: v }; }
  _preview() {
    const cands = (this.entries.value?.entries ?? []).filter((e) => !e.is_pattern).map((e) => e.model_or_pattern);
    const matched = matchesOf(this._form.model_or_pattern, cands);
    return matched.length === 0 ? `No matches yet.` : `Matches ${matched.length}: ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? '…' : ''}`;
  }
  _submitAdd = async () => {
    const f = this._form;
    if (!f.model_or_pattern.trim()) { this._err = 'Model / pattern required.'; return; }
    if (!f.usd_per_image.toString().trim()) { this._err = 'Price required.'; return; }
    this._busy = true; this._err = '';
    try {
      const body = {
        model_or_pattern: f.model_or_pattern.trim(),
        is_pattern: f.is_pattern,
        size: f.size,
        quality: f.quality,
        usd_per_image: f.usd_per_image,
      };
      if (f.is_pattern) body.sort_order = Number(f.sort_order) || 100;
      await rateCardService.createImages(body);
      this._addOpen = false;
      showToast({ kind: 'success', message: 'Added.' });
    } catch (err) { this._err = err?.message ?? 'Failed.'; } finally { this._busy = false; }
  };
  _confirmDelete = async () => {
    const id = this._deleteId; if (!id) return;
    this._busy = true;
    try {
      await rateCardService.deleteImages(id);
      showToast({ kind: 'success', message: 'Deleted.' });
    } catch (err) {
      showToast({ kind: 'error', message: err?.message ?? 'Failed.' });
    } finally { this._busy = false; this._deleteId = null; }
  };
}
if (!customElements.get('admin-rate-card-images')) customElements.define('admin-rate-card-images', AdminRateCardImages);
