import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { customersService } from '../lib/services/customers.service.js';
import { navigate } from '../../shared/lib/route.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-spinner.js';

export class AdminCustomers extends LitElement {
  static properties = {
    _q: { state: true },
    _searching: { state: true },
  };

  constructor() {
    super();
    this.results = new ObservableController(this, customersService.results$);
    this._q = '';
    this._searching = false;
    this._debounce = null;
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
        <input
          type="search"
          placeholder="Search by email or id…"
          .value=${this._q}
          @input=${this._onQueryInput}
          style="width: min(20rem, 100%)"
        />
      </div>
      ${r === null ? html`<bridge-spinner></bridge-spinner>` :
        html`<bridge-table
          .columns=${this._columns()}
          .rows=${r.customers}
          empty="No customers match this query."
        ></bridge-table>`}
    `;
  }

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
