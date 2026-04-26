import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { accountService } from '../lib/services/account.service.js';
import { navigate } from '../../shared/lib/route.js';

import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-button.js';

export class PortalDashboard extends LitElement {
  constructor() {
    super();
    this.account = new ObservableController(this, accountService.account$);
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    if (!accountService.value) void accountService.refresh().catch(() => {});
  }

  render() {
    const a = this.account.value;
    if (!a) return html`<bridge-spinner label="Loading account"></bridge-spinner>`;

    const isFree = a.tier === 'free';
    const quotaTotal = a.free_tokens_remaining != null ? a.free_tokens_remaining : null;
    const remaining = a.free_tokens_remaining ?? 0;
    const low = isFree && remaining > 0 && remaining < 10_000;

    return html`
      <div class="page-header">
        <h1>Welcome${a.email ? `, ${a.email}` : ''}</h1>
        <bridge-button @click=${() => navigate('billing')}>Top up</bridge-button>
      </div>

      <section class="grid">
        <div class="tile">
          <div class="label">Balance</div>
          <div class="value">$${a.balance_usd}</div>
          ${a.reserved_usd && a.reserved_usd !== '0.00' ? html`
            <div class="muted text-sm">Reserved $${a.reserved_usd}</div>
          ` : ''}
        </div>

        ${isFree ? html`
          <div class="tile has-warning">
            <div class="label">Free tier tokens remaining</div>
            <div class="value" data-low=${low ? 'true' : 'false'}>
              ${formatNumber(remaining)}
            </div>
            ${quotaTotal != null ? html`
              <div class="quota-bar">
                <div class="fill" style="width: ${quotaPercent(remaining)}%"></div>
              </div>
            ` : ''}
            ${a.free_tokens_reset_at ? html`
              <div class="muted text-sm">Resets ${new Date(a.free_tokens_reset_at).toLocaleString()}</div>
            ` : ''}
          </div>
        ` : ''}

        <div class="tile">
          <div class="label">Tier</div>
          <div class="value" style="text-transform: capitalize">${a.tier}</div>
          <bridge-button variant="ghost" @click=${() => navigate('keys')}>Manage keys →</bridge-button>
        </div>
      </section>
    `;
  }
}

function formatNumber(n) {
  return new Intl.NumberFormat().format(n);
}

function quotaPercent(remaining) {
  // Free tier monthly is 100k by default. Server returns the actual value
  // separately in /v1/account/limits; use a 100k baseline for the bar.
  const baseline = 100_000;
  return Math.max(0, Math.min(100, Math.round((remaining / baseline) * 100)));
}

if (!customElements.get('portal-dashboard')) customElements.define('portal-dashboard', PortalDashboard);
