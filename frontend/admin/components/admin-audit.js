import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { auditService } from '../lib/services/audit.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-table.js';

export class AdminAudit extends LitElement {
  static properties = {
    _actor: { state: true },
    _action: { state: true },
  };

  constructor() {
    super();
    this.state = new ObservableController(this, auditService.state$);
    this._actor = '';
    this._action = '';
    this._debounce = null;
  }

  createRenderRoot() {
    return this;
  }

  async connectedCallback() {
    super.connectedCallback();
    if (!auditService.value) {
      try {
        await auditService.search({ limit: 200 });
      } catch (err) {
        showToast({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to load audit.',
        });
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._debounce) clearTimeout(this._debounce);
  }

  render() {
    const s = this.state.value;
    return html`
      <div class="page-header">
        <h1>Audit log</h1>
        <bridge-button variant="ghost" @click=${this._exportCsv}>Export CSV</bridge-button>
      </div>

      <section
        style="display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4)"
      >
        <input
          type="text"
          placeholder="Actor (e.g. alice)"
          .value=${this._actor}
          @input=${(e) => {
            this._actor = e.target.value;
            this._schedule();
          }}
          style="width: 14rem"
        />
        <input
          type="text"
          placeholder="Action substring (e.g. /admin/customers)"
          .value=${this._action}
          @input=${(e) => {
            this._action = e.target.value;
            this._schedule();
          }}
          style="width: 22rem"
        />
        <bridge-button variant="ghost" @click=${this._clear}>Clear</bridge-button>
      </section>

      ${s === null
        ? html`<bridge-spinner></bridge-spinner>`
        : html`
            <bridge-table
              .columns=${this._columns()}
              .rows=${s.events}
              empty="No audit events match this query."
            ></bridge-table>
          `}
    `;
  }

  _columns() {
    return [
      {
        field: 'occurred_at',
        header: 'When',
        render: (e) => new Date(e.occurred_at).toLocaleString(),
      },
      {
        field: 'actor',
        header: 'Actor',
        render: (e) => html`<span class="mono text-xs">${e.actor}</span>`,
      },
      {
        field: 'action',
        header: 'Action',
        render: (e) => html`<span class="mono text-xs">${e.action}</span>`,
      },
      {
        field: 'target_id',
        header: 'Target',
        render: (e) =>
          e.target_id
            ? html`<span class="mono text-xs">${e.target_id.slice(0, 12)}…</span>`
            : html`<span class="muted">—</span>`,
      },
      {
        field: 'status_code',
        header: 'Status',
        render: (e) =>
          html`<span data-status=${statusCategory(e.status_code)}>${e.status_code}</span>`,
      },
    ];
  }

  _schedule() {
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => void this._search(), 300);
  }

  async _search() {
    const params = { limit: 200 };
    if (this._actor.trim()) params.actor = this._actor.trim();
    if (this._action.trim()) params.action = this._action.trim();
    try {
      await auditService.search(params);
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Search failed.' });
    }
  }

  async _clear() {
    this._actor = '';
    this._action = '';
    await this._search();
  }

  _exportCsv() {
    const s = this.state.value;
    if (!s) return;
    const header = ['occurred_at', 'actor', 'action', 'target_id', 'status_code'];
    const rows = s.events.map((e) => header.map((k) => csvEscape(e[k] ?? '')).join(','));
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast({ kind: 'success', message: `Exported ${s.events.length} rows.` });
  }
}

function statusCategory(code) {
  if (code >= 200 && code < 300) return 'active';
  if (code >= 400 && code < 500) return 'suspended';
  return 'closed';
}

function csvEscape(v) {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

if (!customElements.get('admin-audit')) customElements.define('admin-audit', AdminAudit);
