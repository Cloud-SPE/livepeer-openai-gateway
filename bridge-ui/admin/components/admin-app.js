import { LitElement, html } from 'lit';
import { BRIDGE_EVENTS, on } from '../../shared/lib/events.js';
import { onHashChange, resolveRoute, withViewTransition, navigate } from '../../shared/lib/route.js';
import { healthService } from '../lib/services/health.service.js';
import { nodesService } from '../lib/services/nodes.service.js';
import { customersService } from '../lib/services/customers.service.js';
import { reservationsService } from '../lib/services/reservations.service.js';
import { topupsService } from '../lib/services/topups.service.js';
import { auditService } from '../lib/services/audit.service.js';
import { configService } from '../lib/services/config.service.js';
import { session, getActor, getToken } from '../lib/session.js';

import './admin-login.js';
import './admin-health.js';
import './admin-nodes.js';
import './admin-node-detail.js';
import './admin-customers.js';
import './admin-customer-detail.js';
import './admin-reservations.js';
import './admin-topups.js';
import './admin-audit.js';
import './admin-config.js';

const TOP_VIEWS = ['health', 'nodes', 'customers', 'reservations', 'topups', 'audit', 'config'];
const ALL_PREFIXES = TOP_VIEWS;

function viewFromHash() {
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#/, '');
  const head = raw.split('/')[0] || '';
  return ALL_PREFIXES.includes(head) ? raw : 'health';
}

export class AdminApp extends LitElement {
  static properties = {
    _authed: { state: true },
    _route: { state: true },
  };

  constructor() {
    super();
    this._authed = !!getToken();
    this._route = viewFromHash();
    this._unsubs = [];
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._unsubs.push(onHashChange(() => {
      const next = viewFromHash();
      withViewTransition(() => { this._route = next; });
    }));
    this._unsubs.push(on(BRIDGE_EVENTS.AUTHENTICATED, () => { this._authed = true; }));
    this._unsubs.push(on(BRIDGE_EVENTS.UNAUTHORIZED, () => {
      this._authed = false;
      healthService.reset();
      nodesService.reset();
      customersService.reset();
      reservationsService.reset();
      topupsService.reset();
      auditService.reset();
      configService.reset();
    }));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const u of this._unsubs) u();
  }

  render() {
    if (!this._authed) return html`<admin-login></admin-login>`;
    const actor = getActor();
    const top = this._route.split('/')[0];

    return html`
      <header class="app-bar">
        <div class="brand">Livepeer Bridge<span class="scope">admin</span></div>
        <nav class="nav">
          ${TOP_VIEWS.map((v) => html`
            <button
              type="button"
              aria-current=${top === v ? 'page' : 'false'}
              @click=${() => navigate(v)}
            >${labelFor(v)}</button>
          `)}
        </nav>
        <div class="meta">
          ${actor ? html`<span class="actor-pill">${actor}</span>` : ''}
          <bridge-button variant="ghost" @click=${this._signOut}>Sign out</bridge-button>
        </div>
      </header>
      <main class="app-main">${this._renderRoute()}</main>
    `;
  }

  _renderRoute() {
    const route = this._route;
    const parts = route.split('/');
    const head = parts[0] || 'health';

    if (head === 'nodes' && parts[1]) {
      return html`<admin-node-detail .nodeId=${parts[1]}></admin-node-detail>`;
    }
    if (head === 'customers' && parts[1]) {
      return html`<admin-customer-detail .customerId=${parts[1]}></admin-customer-detail>`;
    }
    switch (head) {
      case 'nodes': return html`<admin-nodes></admin-nodes>`;
      case 'customers': return html`<admin-customers></admin-customers>`;
      case 'reservations': return html`<admin-reservations></admin-reservations>`;
      case 'topups': return html`<admin-topups></admin-topups>`;
      case 'audit': return html`<admin-audit></admin-audit>`;
      case 'config': return html`<admin-config></admin-config>`;
      case 'health':
      default:
        return html`<admin-health></admin-health>`;
    }
  }

  _signOut() {
    session.clear();
    healthService.reset();
    nodesService.reset();
    customersService.reset();
    reservationsService.reset();
    topupsService.reset();
    auditService.reset();
    configService.reset();
    this._authed = false;
    navigate('health');
  }
}

function labelFor(v) { return v.charAt(0).toUpperCase() + v.slice(1); }

if (!customElements.get('admin-app')) customElements.define('admin-app', AdminApp);
