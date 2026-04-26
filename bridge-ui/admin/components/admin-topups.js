import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { topupsService } from '../lib/services/topups.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-table.js';

const STATUS_OPTIONS = ['', 'pending', 'succeeded', 'failed', 'refunded'];

export class AdminTopups extends LitElement {
  static properties = {
    _customerId: { state: true },
    _status: { state: true },
  };

  constructor() {
    super();
    this.state = new ObservableController(this, topupsService.state$);
    this._customerId = '';
    this._status = '';
    this._debounce = null;
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    if (!topupsService.value) {
      try { await topupsService.search({ limit: 100 }); }
      catch (err) { showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load top-ups.' }); }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._debounce) clearTimeout(this._debounce);
  }

  render() {
    const s = this.state.value;
    return html`
      <div class="page-header"><h1>Top-ups</h1></div>

      <section style="display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4)">
        <input
          type="text"
          placeholder="Customer ID (UUID)"
          .value=${this._customerId}
          @input=${this._onCustomerInput}
          style="width: 22rem; max-width: 100%"
        />
        <select @change=${this._onStatusChange}>
          ${STATUS_OPTIONS.map((s) => html`
            <option value=${s} ?selected=${this._status === s}>${s || 'any status'}</option>
          `)}
        </select>
        <bridge-button variant="ghost" @click=${this._clear}>Clear filters</bridge-button>
      </section>

      ${s === null ? html`<bridge-spinner></bridge-spinner>` : html`
        <bridge-table
          .columns=${this._columns()}
          .rows=${s.topups}
          empty="No top-ups match these filters."
        ></bridge-table>
      `}
    `;
  }

  _columns() {
    return [
      { field: 'created_at', header: 'When', render: (t) => new Date(t.created_at).toLocaleString() },
      { field: 'customer_id', header: 'Customer', render: (t) => html`<span class="mono text-xs">${t.customer_id.slice(0, 8)}…</span>` },
      { field: 'amount_usd_cents', header: 'Amount', render: (t) => `$${(Number(t.amount_usd_cents) / 100).toFixed(2)}` },
      { field: 'status', header: 'Status', render: (t) => html`<span class="badge" data-status=${badgeStatus(t.status)}>${t.status}</span>` },
      { field: 'stripe_session_id', header: 'Stripe session', render: (t) => html`<span class="mono text-xs">${t.stripe_session_id.slice(0, 16)}…</span>` },
    ];
  }

  _onCustomerInput(e) {
    this._customerId = e.target.value;
    this._scheduleSearch();
  }

  _onStatusChange(e) {
    this._status = e.target.value;
    void this._search();
  }

  _scheduleSearch() {
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => void this._search(), 300);
  }

  async _search() {
    const params = { limit: 100 };
    const cid = this._customerId.trim();
    if (cid) params.customer_id = cid;
    if (this._status) params.status = this._status;
    try { await topupsService.search(params); }
    catch (err) { showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Search failed.' }); }
  }

  async _clear() {
    this._customerId = '';
    this._status = '';
    await this._search();
  }
}

function badgeStatus(s) {
  if (s === 'succeeded') return 'active';
  if (s === 'failed' || s === 'refunded') return 'closed';
  return 'suspended';
}

if (!customElements.get('admin-topups')) customElements.define('admin-topups', AdminTopups);
