import { LitElement, html } from 'lit';
import { BRIDGE_EVENTS, on } from '../../shared/lib/events.js';
import { onHashChange, resolveRoute, withViewTransition, navigate } from '../../shared/lib/route.js';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { accountService } from '../lib/services/account.service.js';
import { keysService } from '../lib/services/keys.service.js';
import { topupsService } from '../lib/services/topups.service.js';
import { usageService } from '../lib/services/usage.service.js';
import { session, getApiKey } from '../lib/session.js';

import './portal-login.js';
import './portal-dashboard.js';
import './portal-keys.js';
import './portal-usage.js';
import './portal-billing.js';
import './portal-settings.js';

const VIEWS = ['dashboard', 'keys', 'usage', 'billing', 'settings'];

export class PortalApp extends LitElement {
  static properties = {
    _authed: { state: true },
    _view: { state: true },
  };

  constructor() {
    super();
    this._authed = !!getApiKey();
    this._view = resolveRoute(VIEWS, 'dashboard');
    this.account = new ObservableController(this, accountService.account$);
    this._unsubs = [];
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._unsubs.push(onHashChange(() => {
      const next = resolveRoute(VIEWS, 'dashboard');
      withViewTransition(() => { this._view = next; });
    }));
    this._unsubs.push(on(BRIDGE_EVENTS.AUTHENTICATED, () => {
      this._authed = true;
      void accountService.refresh().catch(() => {});
    }));
    this._unsubs.push(on(BRIDGE_EVENTS.UNAUTHORIZED, () => {
      this._authed = false;
      accountService.signOut();
      keysService.reset();
      usageService.reset();
      topupsService.reset();
    }));
    if (this._authed) void accountService.refresh().catch(() => {});
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const u of this._unsubs) u();
  }

  render() {
    if (!this._authed) return html`<portal-login></portal-login>`;
    const a = this.account.value;
    return html`
      <header class="app-bar">
        <div class="brand">Livepeer Bridge</div>
        <nav class="nav">
          ${VIEWS.map((v) => html`
            <button
              type="button"
              aria-current=${this._view === v ? 'page' : 'false'}
              @click=${() => navigate(v)}
            >${labelFor(v)}</button>
          `)}
        </nav>
        <div class="meta">
          ${a ? html`<span class="tier-pill">${a.tier}</span>` : ''}
          ${a ? html`<span class="mono">$${a.balance_usd}</span>` : ''}
          <bridge-button variant="ghost" @click=${this._signOut}>Sign out</bridge-button>
        </div>
      </header>
      <main class="app-main">${this._renderView()}</main>
    `;
  }

  _renderView() {
    switch (this._view) {
      case 'keys': return html`<portal-keys></portal-keys>`;
      case 'usage': return html`<portal-usage></portal-usage>`;
      case 'billing': return html`<portal-billing></portal-billing>`;
      case 'settings': return html`<portal-settings></portal-settings>`;
      case 'dashboard':
      default:
        return html`<portal-dashboard></portal-dashboard>`;
    }
  }

  _signOut() {
    session.clear();
    accountService.signOut();
    keysService.reset();
    usageService.reset();
    topupsService.reset();
    this._authed = false;
    navigate('dashboard');
  }
}

function labelFor(v) {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

if (!customElements.get('portal-app')) customElements.define('portal-app', PortalApp);
