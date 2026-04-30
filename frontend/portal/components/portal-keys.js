import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { keysService } from '../lib/services/keys.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';
import { getApiKey } from '../lib/session.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-dialog.js';
import '../../shared/components/bridge-confirm-dialog.js';
import '../../shared/components/bridge-spinner.js';

export class PortalKeys extends LitElement {
  static properties = {
    _creating: { state: true },
    _newKey: { state: true }, // Cleartext result of last create — shown once
    _newLabel: { state: true },
    _confirmRevokeId: { state: true },
    _revoking: { state: true },
  };

  constructor() {
    super();
    this.keys = new ObservableController(this, keysService.keys$);
    this._creating = false;
    this._newKey = null;
    this._newLabel = '';
    this._confirmRevokeId = null;
    this._revoking = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (keysService.value === null)
      void keysService.refresh().catch((e) => showToast({ kind: 'error', message: e.message }));
  }

  render() {
    const list = this.keys.value;

    return html`
      <div class="page-header">
        <h1>API keys</h1>
        <bridge-button
          @click=${() => {
            this._creating = true;
            this._newLabel = '';
          }}
        >
          + New key
        </bridge-button>
      </div>

      ${this._newKey
        ? html`
            <div class="new-key">
              <strong>Save this key now — we won't show it again.</strong>
              <code class="mono">${this._newKey.key}</code>
              <bridge-button variant="ghost" @click=${this._copyNewKey}>Copy</bridge-button>
              <bridge-button
                variant="ghost"
                @click=${() => {
                  this._newKey = null;
                }}
                >Dismiss</bridge-button
              >
            </div>
          `
        : ''}
      ${list === null
        ? html`<bridge-spinner></bridge-spinner>`
        : html`
            <bridge-table
              .columns=${this._columns()}
              .rows=${list}
              empty="No keys yet — create one to get started."
            ></bridge-table>
          `}

      <bridge-dialog
        ?open=${this._creating}
        heading="Create new API key"
        @bridge-close=${() => {
          this._creating = false;
        }}
      >
        <p class="muted text-sm">Give this key a label so you can recognise it later.</p>
        <input
          type="text"
          maxlength="64"
          placeholder="e.g. production-server"
          .value=${this._newLabel}
          @input=${(e) => {
            this._newLabel = e.target.value;
          }}
          style="width: 100%; margin-top: var(--space-3);"
        />
        <div slot="actions">
          <bridge-button
            variant="ghost"
            @click=${() => {
              this._creating = false;
            }}
            >Cancel</bridge-button
          >
          <bridge-button @click=${this._submitCreate}>Create key</bridge-button>
        </div>
      </bridge-dialog>

      <bridge-confirm-dialog
        ?open=${this._confirmRevokeId !== null}
        heading="Revoke key?"
        body=${this._revokeBody()}
        confirm-label="Revoke"
        cancel-label="Cancel"
        danger
        ?loading=${this._revoking}
        @bridge-confirm=${this._submitRevoke}
        @bridge-cancel=${() => {
          this._confirmRevokeId = null;
        }}
        @bridge-close=${() => {
          this._confirmRevokeId = null;
        }}
      ></bridge-confirm-dialog>
    `;
  }

  _columns() {
    return [
      {
        field: 'label',
        header: 'Label',
        render: (r) => r.label || html`<span class="muted">unlabeled</span>`,
      },
      { field: 'created_at', header: 'Created', render: (r) => formatDate(r.created_at) },
      {
        field: 'last_used_at',
        header: 'Last used',
        render: (r) =>
          r.last_used_at ? formatDate(r.last_used_at) : html`<span class="muted">never</span>`,
      },
      {
        field: 'status',
        header: 'Status',
        render: (r) => html`
          <span class="key-status" data-revoked=${r.revoked_at ? 'true' : 'false'}>
            ${r.revoked_at ? 'revoked' : 'active'}
          </span>
        `,
      },
      {
        field: 'actions',
        header: '',
        render: (r) =>
          r.revoked_at
            ? ''
            : html`<bridge-button
                variant="ghost"
                @click=${() => {
                  this._confirmRevokeId = r.id;
                }}
                >Revoke</bridge-button
              >`,
      },
    ];
  }

  _revokeBody() {
    const id = this._confirmRevokeId;
    if (!id) return '';
    const list = this.keys.value ?? [];
    const target = list.find((k) => k.id === id);
    const label = target?.label || 'unlabeled key';
    return `Revoke ${label}? Any service using it will start receiving 401 errors immediately.`;
  }

  async _submitCreate() {
    const label = this._newLabel.trim();
    if (!label) {
      showToast({ kind: 'warning', message: 'Label is required.' });
      return;
    }
    try {
      const created = await keysService.create(label);
      this._creating = false;
      this._newKey = created;
      this._newLabel = '';
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to create key.',
      });
    }
  }

  async _submitRevoke() {
    const id = this._confirmRevokeId;
    if (!id) return;

    // Block self-revocation client-side too — server returns 412 but we can give better UX.
    const session = getApiKey();
    const list = this.keys.value ?? [];
    const target = list.find((k) => k.id === id);
    if (target && session && this._isSessionKey(target)) {
      showToast({
        kind: 'error',
        message:
          "You can't revoke the key you're signed in with. Sign in with a different key first.",
      });
      this._confirmRevokeId = null;
      return;
    }

    this._revoking = true;
    try {
      await keysService.revoke(id);
      showToast({ kind: 'success', message: 'Key revoked.' });
      this._confirmRevokeId = null;
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to revoke key.',
      });
    } finally {
      this._revoking = false;
    }
  }

  _isSessionKey(/* keyRow */) {
    // We can't compare the key plaintext against the row (server stores hash only).
    // The 412 response from the server is the real defense; this is a best-effort
    // hint when the user is about to revoke their only key.
    const list = this.keys.value ?? [];
    const active = list.filter((k) => !k.revoked_at);
    return active.length === 1;
  }

  async _copyNewKey() {
    if (!this._newKey) return;
    try {
      await navigator.clipboard.writeText(this._newKey.key);
      showToast({ kind: 'success', message: 'Copied to clipboard.' });
    } catch {
      showToast({
        kind: 'warning',
        message: "Couldn't copy automatically — select and copy manually.",
      });
    }
  }
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

if (!customElements.get('portal-keys')) customElements.define('portal-keys', PortalKeys);
