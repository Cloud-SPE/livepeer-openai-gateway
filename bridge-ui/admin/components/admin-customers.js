import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { customersService } from '../lib/services/customers.service.js';
import { navigate } from '../../shared/lib/route.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-dialog.js';

export class AdminCustomers extends LitElement {
  static properties = {
    _q: { state: true },
    _searching: { state: true },
    _createOpen: { state: true },
    _createBusy: { state: true },
    _createForm: { state: true },
    _createError: { state: true },
  };

  constructor() {
    super();
    this.results = new ObservableController(this, customersService.results$);
    this._q = '';
    this._searching = false;
    this._debounce = null;
    this._createOpen = false;
    this._createBusy = false;
    this._createForm = this._emptyForm();
    this._createError = '';
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    if (!customersService.results) {
      try { await customersService.search({ limit: 50 }); }
      catch (err) { showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Search failed.' }); }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._debounce) clearTimeout(this._debounce);
  }

  render() {
    const r = this.results.value;
    return html`
      <div class="page-header">
        <h1>Customers</h1>
        <div style="display: flex; gap: var(--space-3); align-items: center;">
          <input
            type="search"
            placeholder="Search by email or id…"
            .value=${this._q}
            @input=${this._onQueryInput}
            style="width: min(20rem, 100%)"
          />
          <bridge-button @click=${() => this._openCreate()}>+ New customer</bridge-button>
        </div>
      </div>
      ${r === null ? html`<bridge-spinner></bridge-spinner>` :
        html`<bridge-table
          .columns=${this._columns()}
          .rows=${r.customers}
          empty="No customers match this query."
        ></bridge-table>`}

      <bridge-dialog
        ?open=${this._createOpen}
        heading="Create customer"
        @bridge-close=${() => this._closeCreate()}
      >
        <div style="display: grid; gap: var(--space-3);">
          <label>
            Email
            <input
              type="email"
              required
              maxlength="254"
              style="width: 100%"
              .value=${this._createForm.email}
              @input=${(e) => this._setField('email', e.target.value)}
            />
          </label>
          <label>
            Tier
            <select
              style="width: 100%"
              .value=${this._createForm.tier}
              @change=${(e) => this._setField('tier', e.target.value)}
            >
              <option value="prepaid">prepaid</option>
              <option value="free">free</option>
            </select>
          </label>
          ${this._createForm.tier === 'prepaid' ? html`
            <label>
              Initial balance (USD cents — optional, default 0)
              <input
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                style="width: 100%"
                placeholder="0"
                .value=${this._createForm.balance_usd_cents}
                @input=${(e) => this._setField('balance_usd_cents', e.target.value)}
              />
            </label>
          ` : html`
            <label>
              Monthly token allowance (optional, blank = no limit)
              <input
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                style="width: 100%"
                placeholder="1000000"
                .value=${this._createForm.quota_monthly_allowance}
                @input=${(e) => this._setField('quota_monthly_allowance', e.target.value)}
              />
            </label>
          `}
          <label>
            Rate-limit tier (optional, default 'default')
            <input
              type="text"
              maxlength="64"
              style="width: 100%"
              placeholder="default"
              .value=${this._createForm.rate_limit_tier}
              @input=${(e) => this._setField('rate_limit_tier', e.target.value)}
            />
          </label>
          ${this._createError ? html`<p class="error text-sm" role="alert">${this._createError}</p>` : ''}
        </div>
        <div slot="actions">
          <bridge-button variant="ghost" @click=${() => this._closeCreate()}>Cancel</bridge-button>
          <bridge-button @click=${this._submitCreate} ?loading=${this._createBusy}>Create customer</bridge-button>
        </div>
      </bridge-dialog>
    `;
  }

  _emptyForm() {
    return {
      email: '',
      tier: 'prepaid',
      balance_usd_cents: '',
      quota_monthly_allowance: '',
      rate_limit_tier: '',
    };
  }

  _openCreate() {
    this._createForm = this._emptyForm();
    this._createError = '';
    this._createOpen = true;
  }

  _closeCreate() {
    if (this._createBusy) return;
    this._createOpen = false;
  }

  _setField(name, value) {
    this._createForm = { ...this._createForm, [name]: value };
  }

  _submitCreate = async () => {
    const f = this._createForm;
    if (!f.email || !f.email.includes('@')) {
      this._createError = 'A valid email is required.';
      return;
    }
    /** @type {Record<string, unknown>} */
    const body = { email: f.email.trim(), tier: f.tier };
    if (f.rate_limit_tier.trim()) body.rate_limit_tier = f.rate_limit_tier.trim();
    if (f.tier === 'prepaid' && f.balance_usd_cents.trim()) {
      body.balance_usd_cents = f.balance_usd_cents.trim();
    }
    if (f.tier === 'free' && f.quota_monthly_allowance.trim()) {
      body.quota_monthly_allowance = f.quota_monthly_allowance.trim();
    }
    this._createBusy = true;
    this._createError = '';
    try {
      const created = await customersService.create(body);
      this._createOpen = false;
      showToast({ kind: 'success', message: `Customer ${created.email} created.` });
      // Refresh list so the new row shows up; navigate to detail for next-step actions.
      await customersService.search({ q: this._q.trim() || undefined, limit: 50 });
      navigate(`customers/${created.id}`);
    } catch (err) {
      // 409 surfaces a structured shape; any other error gets the message verbatim.
      const msg = err instanceof Error ? err.message : 'Create failed.';
      this._createError = msg.includes('EmailAlreadyExists') || msg.includes('409')
        ? 'A customer with that email already exists.'
        : msg;
    } finally {
      this._createBusy = false;
    }
  };

  _onQueryInput(e) {
    this._q = e.target.value;
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      void customersService.search({ q: this._q.trim() || undefined, limit: 50 })
        .catch((err) => showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Search failed.' }));
    }, 300);
  }

  _columns() {
    return [
      { field: 'email', header: 'Email', render: (r) => html`<a href="#customers/${r.id}" @click=${(e) => this._goDetail(e, r.id)}>${r.email}</a>` },
      { field: 'tier', header: 'Tier', render: (r) => r.tier },
      {
        field: 'status',
        header: 'Status',
        render: (r) => html`<span class="badge" data-status=${r.status}>${r.status}</span>`,
      },
      { field: 'balance_usd_cents', header: 'Balance', render: (r) => `$${(Number(r.balance_usd_cents) / 100).toFixed(2)}` },
      { field: 'created_at', header: 'Joined', render: (r) => new Date(r.created_at).toLocaleDateString() },
    ];
  }

  _goDetail(e, id) {
    e.preventDefault();
    navigate(`customers/${id}`);
  }
}

if (!customElements.get('admin-customers')) customElements.define('admin-customers', AdminCustomers);
