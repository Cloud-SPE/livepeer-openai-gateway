import { LitElement, html } from 'lit';
import { BRIDGE_EVENTS, emit } from '../../shared/lib/events.js';
import { signIn } from '../lib/api.js';

import '../../shared/components/bridge-button.js';

export class PortalLogin extends LitElement {
  static properties = {
    _apiKey: { state: true },
    _loading: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this._apiKey = '';
    this._loading = false;
    this._error = '';
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <form class="card" @submit=${this._submit} novalidate>
        <h1>Sign in</h1>
        <p>Paste your bridge API key. We'll validate it and remember it for this tab.</p>
        ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : ''}
        <div class="field">
          <label for="apikey">API key</label>
          <input
            id="apikey"
            name="apikey"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="sk-live-..."
            required
            ?disabled=${this._loading}
            .value=${this._apiKey}
            @input=${(e) => {
              this._apiKey = e.target.value;
            }}
          />
        </div>
        <bridge-button block type="submit" ?loading=${this._loading}> Sign in </bridge-button>
      </form>
    `;
  }

  async _submit(e) {
    e.preventDefault();
    if (this._loading) return;
    const key = this._apiKey.trim();
    if (!key) {
      this._error = 'API key is required.';
      return;
    }
    this._loading = true;
    this._error = '';
    try {
      await signIn(key);
      emit(BRIDGE_EVENTS.AUTHENTICATED);
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Sign-in failed.';
    } finally {
      this._loading = false;
    }
  }
}

if (!customElements.get('portal-login')) customElements.define('portal-login', PortalLogin);
