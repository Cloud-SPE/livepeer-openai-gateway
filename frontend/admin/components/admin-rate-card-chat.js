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

const TIERS = ['starter', 'standard', 'pro', 'premium'];

export class AdminRateCardChat extends LitElement {
  static properties = {
    _addOpen: { state: true },
    _busy: { state: true },
    _form: { state: true },
    _err: { state: true },
    _deleteId: { state: true },
    _editingTier: { state: true },
    _tierForm: { state: true },
  };

  constructor() {
    super();
    this.tiers = new ObservableController(this, rateCardService.chatTiers$);
    this.models = new ObservableController(this, rateCardService.chatModels$);
    this._addOpen = false;
    this._busy = false;
    this._form = this._emptyForm();
    this._err = '';
    this._deleteId = null;
    this._editingTier = null;
    this._tierForm = { input_usd_per_million: '', output_usd_per_million: '' };
  }

  createRenderRoot() {
    return this;
  }

  async connectedCallback() {
    super.connectedCallback();
    await Promise.all([
      rateCardService
        .fetchChatTiers()
        .catch((e) => showToast({ kind: 'error', message: e.message })),
      rateCardService
        .fetchChatModels()
        .catch((e) => showToast({ kind: 'error', message: e.message })),
    ]);
  }

  render() {
    const tiers = this.tiers.value?.tiers ?? null;
    const entries = this.models.value?.entries ?? null;
    return html`
      <section style="margin-bottom: var(--space-5);">
        <h2>Tier prices</h2>
        ${tiers === null
          ? html`<bridge-spinner></bridge-spinner>`
          : html` <bridge-table .columns=${this._tierColumns()} .rows=${tiers}></bridge-table> `}
      </section>

      <section>
        <div
          style="display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--space-3);"
        >
          <h2 style="margin:0;">Model → tier</h2>
          <bridge-button @click=${() => this._openAdd()}>+ Add model / pattern</bridge-button>
        </div>
        ${entries === null
          ? html`<bridge-spinner></bridge-spinner>`
          : html`
              <bridge-table
                .columns=${this._modelColumns()}
                .rows=${entries}
                empty="No model entries yet."
              ></bridge-table>
            `}
      </section>

      <bridge-dialog
        ?open=${this._addOpen}
        heading="Add chat model / pattern"
        @bridge-close=${() => this._closeAdd()}
      >
        <div style="display:grid; gap: var(--space-3);">
          <label>
            Type
            <select
              .value=${this._form.is_pattern ? 'pattern' : 'exact'}
              @change=${(e) => this._setField('is_pattern', e.target.value === 'pattern')}
              style="width:100%"
            >
              <option value="exact">Exact model name</option>
              <option value="pattern">Glob pattern (* and ?)</option>
            </select>
          </label>
          <label>
            ${this._form.is_pattern ? 'Pattern' : 'Model name'}
            <input
              type="text"
              maxlength="256"
              style="width:100%"
              placeholder=${this._form.is_pattern ? 'e.g. Qwen3.*' : 'e.g. Qwen3.6-27B'}
              .value=${this._form.model_or_pattern}
              @input=${(e) => this._setField('model_or_pattern', e.target.value)}
            />
            ${this._form.is_pattern && this._form.model_or_pattern
              ? html` <p class="muted text-sm" style="margin: var(--space-1) 0 0;">
                  ${this._patternPreview()}
                </p>`
              : ''}
          </label>
          <label>
            Tier
            <select
              .value=${this._form.tier}
              @change=${(e) => this._setField('tier', e.target.value)}
              style="width:100%"
            >
              ${TIERS.map((t) => html`<option value=${t}>${t}</option>`)}
            </select>
          </label>
          ${this._form.is_pattern
            ? html` <label>
                Sort order (lower wins on ambiguous matches)
                <input
                  type="number"
                  min="0"
                  max="10000"
                  style="width:100%"
                  .value=${this._form.sort_order}
                  @input=${(e) => this._setField('sort_order', e.target.value)}
                />
              </label>`
            : ''}
          ${this._err ? html`<p class="error text-sm" role="alert">${this._err}</p>` : ''}
        </div>
        <div slot="actions">
          <bridge-button variant="ghost" @click=${() => this._closeAdd()}>Cancel</bridge-button>
          <bridge-button @click=${this._submitAdd} ?loading=${this._busy}>Add</bridge-button>
        </div>
      </bridge-dialog>

      <bridge-confirm-dialog
        ?open=${this._deleteId !== null}
        heading="Delete entry?"
        body="This removes the rate-card entry. Customers requesting this model will get model_not_found until you re-add it."
        confirm-label="Delete"
        cancel-label="Cancel"
        danger
        ?loading=${this._busy}
        @bridge-confirm=${this._confirmDelete}
        @bridge-cancel=${() => {
          this._deleteId = null;
        }}
        @bridge-close=${() => {
          this._deleteId = null;
        }}
      ></bridge-confirm-dialog>

      <bridge-dialog
        ?open=${this._editingTier !== null}
        heading=${`Edit ${this._editingTier ?? ''} tier price`}
        @bridge-close=${() => {
          this._editingTier = null;
        }}
      >
        <div style="display:grid; gap: var(--space-3);">
          <label>
            Input price (USD per 1M tokens)
            <input
              type="text"
              inputmode="decimal"
              style="width:100%"
              .value=${this._tierForm.input_usd_per_million}
              @input=${(e) =>
                (this._tierForm = { ...this._tierForm, input_usd_per_million: e.target.value })}
            />
          </label>
          <label>
            Output price (USD per 1M tokens)
            <input
              type="text"
              inputmode="decimal"
              style="width:100%"
              .value=${this._tierForm.output_usd_per_million}
              @input=${(e) =>
                (this._tierForm = { ...this._tierForm, output_usd_per_million: e.target.value })}
            />
          </label>
        </div>
        <div slot="actions">
          <bridge-button
            variant="ghost"
            @click=${() => {
              this._editingTier = null;
            }}
            >Cancel</bridge-button
          >
          <bridge-button @click=${this._submitTierEdit} ?loading=${this._busy}>Save</bridge-button>
        </div>
      </bridge-dialog>
    `;
  }

  _tierColumns() {
    return [
      { field: 'tier', header: 'Tier', render: (r) => r.tier },
      {
        field: 'input_usd_per_million',
        header: 'Input ($/M tok)',
        render: (r) => Number(r.input_usd_per_million).toFixed(4),
      },
      {
        field: 'output_usd_per_million',
        header: 'Output ($/M tok)',
        render: (r) => Number(r.output_usd_per_million).toFixed(4),
      },
      {
        field: 'updated_at',
        header: 'Updated',
        render: (r) => new Date(r.updated_at).toLocaleString(),
      },
      {
        field: 'actions',
        header: '',
        render: (r) =>
          html`<bridge-button variant="ghost" @click=${() => this._openTierEdit(r)}
            >Edit</bridge-button
          >`,
      },
    ];
  }

  _modelColumns() {
    return [
      {
        field: 'model_or_pattern',
        header: 'Model / Pattern',
        render: (r) =>
          html`<span
            >${r.model_or_pattern}${r.is_pattern
              ? html` <span class="muted">(glob)</span>`
              : ''}</span
          >`,
      },
      { field: 'tier', header: 'Tier', render: (r) => r.tier },
      { field: 'sort_order', header: 'Sort', render: (r) => (r.is_pattern ? r.sort_order : '—') },
      {
        field: 'created_at',
        header: 'Created',
        render: (r) => new Date(r.created_at).toLocaleDateString(),
      },
      {
        field: 'actions',
        header: '',
        render: (r) =>
          html`<bridge-button variant="ghost" @click=${() => this._askDelete(r.id)}
            >Delete</bridge-button
          >`,
      },
    ];
  }

  _emptyForm() {
    return { model_or_pattern: '', is_pattern: false, tier: 'standard', sort_order: 100 };
  }
  _openAdd() {
    this._form = this._emptyForm();
    this._err = '';
    this._addOpen = true;
  }
  _closeAdd() {
    if (!this._busy) this._addOpen = false;
  }
  _setField(name, value) {
    this._form = { ...this._form, [name]: value };
  }
  _patternPreview() {
    const candidates = (this.models.value?.entries ?? [])
      .filter((e) => !e.is_pattern)
      .map((e) => e.model_or_pattern);
    const matched = matchesOf(this._form.model_or_pattern, candidates);
    return matched.length === 0
      ? `No exact entries match "${this._form.model_or_pattern}". (Patterns also match models the registry advertises.)`
      : `Matches ${matched.length}: ${matched.slice(0, 5).join(', ')}${matched.length > 5 ? '…' : ''}`;
  }
  _submitAdd = async () => {
    const f = this._form;
    if (!f.model_or_pattern.trim()) {
      this._err = 'Model / pattern is required.';
      return;
    }
    this._busy = true;
    this._err = '';
    try {
      const body = {
        model_or_pattern: f.model_or_pattern.trim(),
        is_pattern: f.is_pattern,
        tier: f.tier,
      };
      if (f.is_pattern) body.sort_order = Number(f.sort_order) || 100;
      await rateCardService.createChatModel(body);
      this._addOpen = false;
      showToast({ kind: 'success', message: 'Entry added.' });
    } catch (err) {
      this._err = err?.message ?? 'Failed.';
    } finally {
      this._busy = false;
    }
  };
  _askDelete(id) {
    this._deleteId = id;
  }
  _confirmDelete = async () => {
    const id = this._deleteId;
    if (!id) return;
    this._busy = true;
    try {
      await rateCardService.deleteChatModel(id);
      showToast({ kind: 'success', message: 'Entry deleted.' });
    } catch (err) {
      showToast({ kind: 'error', message: err?.message ?? 'Delete failed.' });
    } finally {
      this._busy = false;
      this._deleteId = null;
    }
  };
  _openTierEdit(row) {
    this._editingTier = row.tier;
    this._tierForm = {
      input_usd_per_million: String(row.input_usd_per_million),
      output_usd_per_million: String(row.output_usd_per_million),
    };
  }
  _submitTierEdit = async () => {
    if (!this._editingTier) return;
    this._busy = true;
    try {
      await rateCardService.updateChatTier(this._editingTier, this._tierForm);
      this._editingTier = null;
      showToast({ kind: 'success', message: 'Tier prices updated.' });
    } catch (err) {
      showToast({ kind: 'error', message: err?.message ?? 'Update failed.' });
    } finally {
      this._busy = false;
    }
  };
}

if (!customElements.get('admin-rate-card-chat')) {
  customElements.define('admin-rate-card-chat', AdminRateCardChat);
}
