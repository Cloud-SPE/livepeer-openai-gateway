import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { reservationsService } from '../lib/services/reservations.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-table.js';

export class AdminReservations extends LitElement {
  constructor() {
    super();
    this.state = new ObservableController(this, reservationsService.state$);
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    if (!reservationsService.value) {
      try { await reservationsService.search({ state: 'open', limit: 100 }); }
      catch (err) { showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load reservations.' }); }
    }
  }

  render() {
    const s = this.state.value;
    if (!s) return html`<bridge-spinner></bridge-spinner>`;
    return html`
      <div class="page-header">
        <h1>Open reservations</h1>
        <span class="muted text-sm">${s.reservations.length} open · oldest first</span>
      </div>
      <p class="muted text-sm" style="margin-top: 0; margin-bottom: var(--space-4)">
        Read-only investigation view. Stuck reservations are a symptom; fix upstream
        (PayerDaemon, node health) and let reconciliation close them.
      </p>
      <bridge-table
        .columns=${this._columns()}
        .rows=${s.reservations}
        empty="No open reservations — fleet is healthy."
      ></bridge-table>
    `;
  }

  _columns() {
    return [
      { field: 'work_id', header: 'Work ID', render: (r) => html`<span class="mono text-xs">${r.work_id}</span>` },
      { field: 'customer_id', header: 'Customer', render: (r) => html`<span class="mono text-xs">${r.customer_id.slice(0, 8)}…</span>` },
      { field: 'kind', header: 'Kind' },
      { field: 'amount_usd_cents', header: 'Amount', render: (r) => formatAmount(r) },
      { field: 'age_seconds', header: 'Age', render: (r) => formatAge(r.age_seconds) },
      { field: 'created_at', header: 'Started', render: (r) => new Date(r.created_at).toLocaleString() },
    ];
  }
}

function formatAmount(r) {
  if (r.amount_usd_cents != null) return `$${(Number(r.amount_usd_cents) / 100).toFixed(2)}`;
  if (r.amount_tokens != null) return `${Number(r.amount_tokens).toLocaleString()} tokens`;
  return '—';
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

if (!customElements.get('admin-reservations')) customElements.define('admin-reservations', AdminReservations);
