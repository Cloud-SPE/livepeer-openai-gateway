import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { topupsService } from '../lib/services/topups.service.js';
import { accountService } from '../lib/services/account.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-spinner.js';

const PRESETS = [10, 25, 50, 100];

export class PortalBilling extends LitElement {
  static properties = {
    _amount: { state: true },
    _starting: { state: true },
  };

  constructor() {
    super();
    this.topups = new ObservableController(this, topupsService.topups$);
    this._amount = 25;
    this._starting = false;
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    if (topupsService.value === null) {
      void topupsService.refresh().catch((e) => showToast({ kind: 'error', message: e.message }));
    }
  }

  render() {
    const list = this.topups.value;

    return html`
      <div class="page-header"><h1>Billing</h1></div>

      <section class="tile" style="margin-bottom: var(--space-5); display: grid; gap: var(--space-3); padding: var(--space-5); background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg)">
        <h3 style="margin: 0">Top up</h3>
        <div style="display: flex; gap: var(--space-2); flex-wrap: wrap">
          ${PRESETS.map((p) => html`
            <bridge-button
              variant=${this._amount === p ? 'primary' : 'ghost'}
              @click=${() => { this._amount = p; }}
            >$${p}</bridge-button>
          `)}
          <input
            type="number"
            min="1"
            max="1000"
            step="1"
            .value=${String(this._amount)}
            @input=${(e) => { this._amount = Number(e.target.value); }}
            style="width: 8rem"
          />
        </div>
        <bridge-button @click=${this._start} ?loading=${this._starting}>
          Pay $${this._amount} via Stripe
        </bridge-button>
      </section>

      <h2>History</h2>
      ${list === null ? html`<bridge-spinner></bridge-spinner>` : html`
        <bridge-table
          .columns=${this._columns()}
          .rows=${list}
          empty="No top-ups yet."
        ></bridge-table>
      `}
    `;
  }

  _columns() {
    return [
      { field: 'created_at', header: 'Date', render: (r) => formatDate(r.created_at) },
      { field: 'amount_usd', header: 'Amount', render: (r) => `$${r.amount_usd}` },
      { field: 'status', header: 'Status', render: (r) => statusBadge(r.status) },
      { field: 'stripe_session_id', header: 'Stripe session', render: (r) => html`<span class="mono text-xs">${r.stripe_session_id.slice(0, 16)}…</span>` },
    ];
  }

  async _start() {
    if (this._starting) return;
    const amount = Math.max(1, Math.floor(this._amount));
    if (!Number.isFinite(amount) || amount < 1) {
      showToast({ kind: 'warning', message: 'Enter an amount in dollars.' });
      return;
    }
    this._starting = true;
    try {
      const { url } = await topupsService.startCheckout(amount * 100);
      window.location.assign(url);
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to start checkout.' });
      this._starting = false;
    }
  }
}

function statusBadge(s) {
  const color = s === 'succeeded' ? 'var(--success)'
    : s === 'failed' || s === 'refunded' || s === 'disputed' ? 'var(--danger)'
    : 'var(--text-3)';
  return html`<span style="color: ${color}; font-weight: 600">${s}</span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

if (!customElements.get('portal-billing')) customElements.define('portal-billing', PortalBilling);
