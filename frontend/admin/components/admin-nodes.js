import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { nodesService } from '../lib/services/nodes.service.js';
import { navigate } from '../../shared/lib/route.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-button.js';

export class AdminNodes extends LitElement {
  constructor() {
    super();
    this.nodes = new ObservableController(this, nodesService.nodes$);
  }

  createRenderRoot() {
    return this;
  }

  async connectedCallback() {
    super.connectedCallback();
    if (!nodesService.value) {
      try {
        await nodesService.refresh();
      } catch (err) {
        showToast({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to load nodes.',
        });
      }
    }
  }

  render() {
    const list = this.nodes.value;
    if (list === null) return html`<bridge-spinner></bridge-spinner>`;
    return html`
      <div class="page-header">
        <h1>Nodes</h1>
        <span class="muted text-sm">${list.length} total</span>
      </div>
      <bridge-table
        .columns=${this._columns()}
        .rows=${this._sortedRows(list)}
        empty="No nodes loaded — check service-registry-daemon."
      ></bridge-table>
    `;
  }

  _sortedRows(list) {
    const order = { circuit_broken: 0, degraded: 1, healthy: 2 };
    return [...list].sort((a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99));
  }

  _columns() {
    return [
      {
        field: 'id',
        header: 'ID',
        render: (r) =>
          html`<a href="#nodes/${r.id}" @click=${(e) => this._goDetail(e, r.id)}>${r.id}</a>`,
      },
      {
        field: 'url',
        header: 'URL',
        render: (r) => html`<span class="mono text-xs">${r.url}</span>`,
      },
      {
        field: 'status',
        header: 'Status',
        render: (r) =>
          html`<span class="badge" data-status=${r.status}>${r.status.replace('_', ' ')}</span>`,
      },
      {
        field: 'eligibility',
        header: 'Eligibility',
        render: (r) =>
          html`<span class="badge" data-status=${eligibilityBadge(r.eligibility)}
            >${r.eligibility}</span
          >`,
      },
      {
        field: 'eligibleCapabilities',
        header: 'Capabilities',
        render: (r) =>
          (r.eligibleCapabilities ?? []).join(', ') || html`<span class="muted">none</span>`,
      },
      {
        field: 'tierAllowed',
        header: 'Tier',
        render: (r) => (r.tierAllowed ?? []).join(', '),
      },
      {
        field: 'enabled',
        header: 'Enabled',
        render: (r) => (r.enabled ? 'yes' : html`<span class="muted">no</span>`),
      },
      { field: 'weight', header: 'Weight' },
    ];
  }

  _goDetail(e, id) {
    e.preventDefault();
    navigate(`nodes/${id}`);
  }
}

function eligibilityBadge(eligibility) {
  if (eligibility === 'eligible') return 'healthy';
  if (eligibility === 'unknown') return 'degraded';
  return 'circuit_broken';
}

if (!customElements.get('admin-nodes')) customElements.define('admin-nodes', AdminNodes);
