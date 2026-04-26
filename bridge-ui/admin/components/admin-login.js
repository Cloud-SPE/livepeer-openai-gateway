import { LitElement, html } from 'lit';
import { BRIDGE_EVENTS, emit } from '../../shared/lib/events.js';
import { signIn } from '../lib/api.js';

import '../../shared/components/bridge-button.js';

export class AdminLogin extends LitElement {
  static properties = {
    _token: { state: true },
    _actor: { state: true },
    _loading: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this._token = '';
    this._actor = '';
    this._loading = false;
    this._error = '';
  }

  createRenderRoot() { return this; }

  render() {
    return html`
      <form class="card" @submit=${this._submit} novalidate>
        <h1>Operator sign-in</h1>
        <p>Provide the admin token and your handle. The handle attributes audit-log entries.</p>
        ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : ''}

        <div class="field">
          <label for="token">Admin token</label>
          <input
            id="token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="X-Admin-Token"
            required
            ?disabled=${this._loading}
            .value=${this._token}
            @input=${(e) => { this._token = e.target.value; }}
          />
        </div>

        <div class="field">
          <label for="actor">Operator handle</label>
          <input
            id="actor"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="alice"
            pattern="^[a-z0-9._-]{1,64}$"
            required
            ?disabled=${this._loading}
            .value=${this._actor}
            @input=${(e) => { this._actor = e.target.value; }}
          />
        </div>

        <bridge-button block type="submit" ?loading=${this._loading}>Sign in</bridge-button>
      </form>
    `;
  }

  async _submit(e) {
    e.preventDefault();
    if (this._loading) return;
    const token = this._token.trim();
    const actor = this._actor.trim();
    if (!token || !actor) {
      this._error = 'Both fields are required.';
      return;
    }
    this._loading = true;
    this._error = '';
    try {
      await signIn(token, actor);
      emit(BRIDGE_EVENTS.AUTHENTICATED);
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Sign-in failed.';
    } finally {
      this._loading = false;
    }
  }
}

if (!customElements.get('admin-login')) customElements.define('admin-login', AdminLogin);
