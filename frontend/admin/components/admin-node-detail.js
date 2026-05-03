import { LitElement, html } from 'lit';
import { nodesService } from '../lib/services/nodes.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';
import { navigate } from '../../shared/lib/route.js';

import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-button.js';

export class AdminNodeDetail extends LitElement {
  static properties = {
    nodeId: { type: String },
    _detail: { state: true },
    _events: { state: true },
  };

  constructor() {
    super();
    this.nodeId = '';
    this._detail = null;
    this._events = null;
  }

  createRenderRoot() {
    return this;
  }

  updated(changed) {
    if (changed.has('nodeId') && this.nodeId) {
      void this._load();
    }
  }

  async _load() {
    try {
      const [detail, events] = await Promise.all([
        nodesService.getDetail(this.nodeId),
        nodesService.getEvents(this.nodeId, { limit: 50 }),
      ]);
      this._detail = detail;
      this._events = events?.events ?? [];
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load node detail.',
      });
    }
  }

  render() {
    const d = this._detail;
    if (!d) return html`<bridge-spinner></bridge-spinner>`;
    return html`
      <div class="page-header">
        <h1>Node ${d.id}</h1>
        <bridge-button variant="ghost" @click=${() => navigate('nodes')}>← All nodes</bridge-button>
      </div>

      <section
        style="background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg); padding: var(--space-5); margin-bottom: var(--space-5)"
      >
        <dl
          style="display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-4); margin: 0"
        >
          <dt class="muted text-sm">URL</dt>
          <dd class="mono text-xs" style="margin: 0">${d.url}</dd>
          <dt class="muted text-sm">Status</dt>
          <dd style="margin: 0">
            <span class="badge" data-status=${d.status}>${d.status.replace('_', ' ')}</span>
          </dd>
          <dt class="muted text-sm">Eligibility</dt>
          <dd style="margin: 0">
            <span class="badge" data-status=${eligibilityBadge(d.eligibility)}>${d.eligibility}</span>
          </dd>
          <dt class="muted text-sm">Capabilities</dt>
          <dd style="margin: 0">
            ${(d.eligibleCapabilities ?? []).join(', ') || html`<span class="muted">none</span>`}
          </dd>
          <dt class="muted text-sm">Ineligible reason</dt>
          <dd style="margin: 0">${formatReason(d.ineligibleReason)}</dd>
          <dt class="muted text-sm">Enabled</dt>
          <dd style="margin: 0">${d.enabled ? 'yes' : 'no'}</dd>
          <dt class="muted text-sm">Tier allowed</dt>
          <dd style="margin: 0">${(d.tierAllowed ?? []).join(', ')}</dd>
          <dt class="muted text-sm">Models</dt>
          <dd style="margin: 0">
            ${(d.supportedModels ?? []).join(', ') || html`<span class="muted">none</span>`}
          </dd>
          <dt class="muted text-sm">Weight</dt>
          <dd style="margin: 0">${d.weight}</dd>
          ${d.circuit
            ? html`
                <dt class="muted text-sm">Consecutive failures</dt>
                <dd style="margin: 0">${d.circuit.consecutiveFailures}</dd>
                <dt class="muted text-sm">Last success</dt>
                <dd style="margin: 0">${formatDate(d.circuit.lastSuccessAt)}</dd>
                <dt class="muted text-sm">Last failure</dt>
                <dd style="margin: 0">${formatDate(d.circuit.lastFailureAt)}</dd>
                <dt class="muted text-sm">Circuit opened</dt>
                <dd style="margin: 0">${formatDate(d.circuit.circuitOpenedAt)}</dd>
              `
            : ''}
        </dl>
      </section>

      <h2 style="margin: 0 0 var(--space-3)">Events</h2>
      ${this._events === null
        ? html`<bridge-spinner></bridge-spinner>`
        : this._events.length === 0
          ? html`<p class="muted">No events recorded for this node.</p>`
          : html`<div class="timeline">
              ${this._events.map(
                (e) => html`
                  <div class="event">
                    <time>${new Date(e.occurred_at).toLocaleString()}</time>
                    <div>
                      <div class="kind">${e.kind.replace('_', ' ')}</div>
                      ${e.detail ? html`<div class="muted text-sm">${e.detail}</div>` : ''}
                    </div>
                  </div>
                `,
              )}
            </div>`}
    `;
  }
}

function formatDate(iso) {
  if (!iso) return html`<span class="muted">—</span>`;
  return new Date(iso).toLocaleString();
}

function formatReason(reason) {
  if (!reason) return html`<span class="muted">—</span>`;
  return reason.replaceAll('_', ' ');
}

function eligibilityBadge(eligibility) {
  if (eligibility === 'eligible') return 'healthy';
  if (eligibility === 'unknown') return 'degraded';
  return 'circuit_broken';
}

if (!customElements.get('admin-node-detail'))
  customElements.define('admin-node-detail', AdminNodeDetail);
