import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { accountService } from '../lib/services/account.service.js';
import { api } from '../lib/api.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-spinner.js';

export class PortalSettings extends LitElement {
  static properties = { _limits: { state: true } };

  constructor() {
    super();
    this.account = new ObservableController(this, accountService.account$);
    this._limits = null;
  }

  createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    try {
      this._limits = await api.get('/v1/account/limits');
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load limits.' });
    }
  }

  render() {
    const a = this.account.value;
    const l = this._limits;
    if (!a) return html`<bridge-spinner></bridge-spinner>`;

    return html`
      <div class="page-header"><h1>Settings</h1></div>
      <section style="display: grid; gap: var(--space-4); max-width: 40rem">
        <div class="tile" style="padding: var(--space-5); background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg)">
          <h3 style="margin: 0 0 var(--space-3)">Account</h3>
          <dl style="display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-4); margin: 0">
            <dt class="muted text-sm">Email</dt><dd style="margin: 0">${a.email}</dd>
            <dt class="muted text-sm">Tier</dt><dd style="margin: 0; text-transform: capitalize">${a.tier}</dd>
            <dt class="muted text-sm">Status</dt><dd style="margin: 0; text-transform: capitalize">${a.status}</dd>
            <dt class="muted text-sm">Joined</dt><dd style="margin: 0">${new Date(a.created_at).toLocaleDateString()}</dd>
          </dl>
        </div>

        ${l ? html`
          <div class="tile" style="padding: var(--space-5); background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg)">
            <h3 style="margin: 0 0 var(--space-3)">Rate limits</h3>
            <dl style="display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-4); margin: 0">
              <dt class="muted text-sm">Concurrent</dt><dd style="margin: 0">${l.max_concurrent}</dd>
              <dt class="muted text-sm">Requests / min</dt><dd style="margin: 0">${l.requests_per_minute}</dd>
              <dt class="muted text-sm">Tokens / req</dt><dd style="margin: 0">${l.max_tokens_per_request.toLocaleString()}</dd>
              <dt class="muted text-sm">Monthly quota</dt><dd style="margin: 0">${l.monthly_token_quota != null ? l.monthly_token_quota.toLocaleString() : 'unlimited'}</dd>
            </dl>
          </div>
        ` : ''}
      </section>
    `;
  }
}

if (!customElements.get('portal-settings')) customElements.define('portal-settings', PortalSettings);
