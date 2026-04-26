import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { healthService } from '../lib/services/health.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-spinner.js';

const GRAFANA_URL =
  typeof window !== 'undefined' && window.GRAFANA_DASHBOARD_URL
    ? window.GRAFANA_DASHBOARD_URL
    : '';

export class AdminHealth extends LitElement {
  constructor() {
    super();
    this.health = new ObservableController(this, healthService.health$);
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    if (!healthService.value) {
      try { await healthService.refresh(); }
      catch (err) { showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load health.' }); }
    }
  }

  render() {
    const h = this.health.value;
    if (!h) return html`<bridge-spinner label="Loading health"></bridge-spinner>`;
    return html`
      <div class="page-header"><h1>Fleet health</h1></div>

      <section class="tiles">
        ${tile('PayerDaemon', h.payerDaemonHealthy ? 'healthy' : 'down', h.payerDaemonHealthy ? 'OK' : 'unhealthy')}
        ${tile('Database', h.dbOk ? 'healthy' : 'down', h.dbOk ? 'OK' : 'unhealthy')}
        ${tile('Redis', h.redisOk ? 'healthy' : 'down', h.redisOk ? 'OK' : 'unhealthy')}
        ${tile('Nodes', h.nodesHealthy === h.nodeCount ? 'healthy' : h.nodesHealthy > 0 ? 'warn' : 'down',
                `${h.nodesHealthy} / ${h.nodeCount}`)}
      </section>

      <section class="grafana">
        ${GRAFANA_URL
          ? html`<iframe src=${GRAFANA_URL} width="100%" height="600" frameborder="0" title="Grafana — bridge dashboard"></iframe>`
          : html`<div class="grafana-empty">
              Configure <code>window.GRAFANA_DASHBOARD_URL</code> to embed the Grafana dashboard here.
            </div>`}
      </section>
    `;
  }
}

function tile(label, status, valueText) {
  return html`
    <div class="tile">
      <div class="label">${label}</div>
      <div class="value" data-status=${status}>${valueText}</div>
    </div>
  `;
}

if (!customElements.get('admin-health')) customElements.define('admin-health', AdminHealth);
