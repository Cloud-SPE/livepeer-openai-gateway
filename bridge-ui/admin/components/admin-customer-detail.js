import { LitElement, html } from 'lit';
import { customersService } from '../lib/services/customers.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';
import { navigate } from '../../shared/lib/route.js';

import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-confirm-dialog.js';
import '../../shared/components/bridge-dialog.js';

const ACTIONS = Object.freeze({
  REFUND: 'refund',
  SUSPEND: 'suspend',
  UNSUSPEND: 'unsuspend',
});

export class AdminCustomerDetail extends LitElement {
  static properties = {
    customerId: { type: String },
    _detail: { state: true },
    _action: { state: true }, // current action being confirmed
    _refundSession: { state: true }, // chosen Stripe session id when action=refund
    _refundReason: { state: true },
    _busy: { state: true },
    _newKey: { state: true }, // cleartext result of issue-key
    _issueOpen: { state: true },
    _issueLabel: { state: true },
  };

  constructor() {
    super();
    this.customerId = '';
    this._detail = null;
    this._action = null;
    this._refundSession = '';
    this._refundReason = 'operator-issued refund';
    this._busy = false;
    this._newKey = null;
    this._issueOpen = false;
    this._issueLabel = '';
  }

  createRenderRoot() {
    return this;
  }

  updated(changed) {
    if (changed.has('customerId') && this.customerId) void this._load();
  }

  async _load() {
    try {
      this._detail = await customersService.select(this.customerId);
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load customer.',
      });
    }
  }

  render() {
    const d = this._detail;
    if (!d) return html`<bridge-spinner></bridge-spinner>`;
    const successfulTopups = (d.topups ?? []).filter((t) => t.status === 'succeeded');

    return html`
      <div class="page-header">
        <h1>${d.email}</h1>
        <bridge-button variant="ghost" @click=${() => navigate('customers')}
          >← All customers</bridge-button
        >
      </div>

      <section class="panel">
        <dl>
          <dt>ID</dt>
          <dd class="mono text-xs">${d.id}</dd>
          <dt>Tier</dt>
          <dd>${d.tier}</dd>
          <dt>Status</dt>
          <dd><span class="badge" data-status=${d.status}>${d.status}</span></dd>
          <dt>Balance</dt>
          <dd>$${formatCents(d.balanceUsdCents)}</dd>
          <dt>Reserved</dt>
          <dd>$${formatCents(d.reservedUsdCents)}</dd>
          <dt>Rate-limit tier</dt>
          <dd>${d.rateLimitTier}</dd>
          <dt>Joined</dt>
          <dd>${new Date(d.createdAt).toLocaleString()}</dd>
        </dl>
        <div class="actions">
          ${d.status === 'active'
            ? html`<bridge-button variant="danger" @click=${() => this._open(ACTIONS.SUSPEND)}
                >Suspend</bridge-button
              >`
            : html`<bridge-button @click=${() => this._open(ACTIONS.UNSUSPEND)}
                >Unsuspend</bridge-button
              >`}
          ${successfulTopups.length > 0
            ? html`<bridge-button
                variant="danger"
                @click=${() => this._openRefund(successfulTopups[0].stripeSessionId)}
                >Refund last top-up</bridge-button
              >`
            : ''}
          <bridge-button
            variant="ghost"
            @click=${() => {
              this._issueOpen = true;
              this._issueLabel = '';
            }}
            >Issue API key</bridge-button
          >
        </div>
      </section>

      <section class="panel">
        <h3 style="margin: 0 0 var(--space-3)">Recent top-ups</h3>
        ${(d.topups ?? []).length === 0
          ? html`<p class="muted">None.</p>`
          : html`
              <ul style="display: grid; gap: var(--space-2); margin: 0; padding: 0">
                ${d.topups.map(
                  (t) => html`
                    <li
                      style="display: flex; justify-content: space-between; gap: var(--space-3); border-bottom: 1px solid var(--border-1); padding-bottom: var(--space-2)"
                    >
                      <span class="mono text-xs">${t.stripeSessionId.slice(0, 16)}…</span>
                      <span>$${formatCents(t.amountUsdCents)}</span>
                      <span
                        class="badge"
                        data-status=${t.status === 'succeeded'
                          ? 'active'
                          : t.status === 'refunded'
                            ? 'closed'
                            : 'suspended'}
                        >${t.status}</span
                      >
                      <span class="muted text-sm">${new Date(t.createdAt).toLocaleString()}</span>
                    </li>
                  `,
                )}
              </ul>
            `}
      </section>

      ${this._newKey
        ? html`
            <section
              class="panel"
              style="background: var(--success-tint); border-color: var(--success)"
            >
              <strong>Save this key now — it won't be shown again.</strong>
              <code
                class="mono"
                style="display: block; padding: var(--space-2) var(--space-3); margin-top: var(--space-2); background: var(--surface-1); border-radius: var(--radius-sm); user-select: all; overflow-wrap: anywhere"
                >${this._newKey.key}</code
              >
              <bridge-button
                variant="ghost"
                @click=${() => {
                  this._newKey = null;
                }}
                >Dismiss</bridge-button
              >
            </section>
          `
        : ''}

      <bridge-dialog
        ?open=${this._issueOpen}
        heading="Issue API key for ${d.email}"
        @bridge-close=${() => {
          this._issueOpen = false;
        }}
      >
        <p class="muted text-sm">Give it a label (e.g. operator-issued).</p>
        <input
          type="text"
          maxlength="64"
          style="width: 100%; margin-top: var(--space-3)"
          placeholder="operator-issued"
          .value=${this._issueLabel}
          @input=${(e) => {
            this._issueLabel = e.target.value;
          }}
        />
        <div slot="actions">
          <bridge-button
            variant="ghost"
            @click=${() => {
              this._issueOpen = false;
            }}
            >Cancel</bridge-button
          >
          <bridge-button @click=${this._submitIssue}>Issue key</bridge-button>
        </div>
      </bridge-dialog>

      <bridge-confirm-dialog
        ?open=${this._action === ACTIONS.SUSPEND}
        heading="Suspend ${d.email}?"
        body="Suspending halts API access immediately. Type the email to confirm."
        confirm-label="Suspend"
        cancel-label="Cancel"
        required-text=${d.email}
        danger
        ?loading=${this._busy}
        @bridge-confirm=${() => this._submit(ACTIONS.SUSPEND)}
        @bridge-cancel=${() => {
          this._action = null;
        }}
        @bridge-close=${() => {
          this._action = null;
        }}
      ></bridge-confirm-dialog>

      <bridge-confirm-dialog
        ?open=${this._action === ACTIONS.REFUND}
        heading="Refund top-up?"
        body=${`Reverse Stripe session ${this._refundSession.slice(0, 16)}… for ${d.email}. Type the email to confirm.`}
        confirm-label="Refund"
        cancel-label="Cancel"
        required-text=${d.email}
        danger
        ?loading=${this._busy}
        @bridge-confirm=${() => this._submit(ACTIONS.REFUND)}
        @bridge-cancel=${() => {
          this._action = null;
        }}
        @bridge-close=${() => {
          this._action = null;
        }}
      ></bridge-confirm-dialog>

      <bridge-dialog
        ?open=${this._action === ACTIONS.UNSUSPEND}
        heading="Unsuspend ${d.email}?"
        @bridge-close=${() => {
          this._action = null;
        }}
      >
        <p>Restoring service for ${d.email}. Confirm to proceed.</p>
        <div slot="actions">
          <bridge-button
            variant="ghost"
            @click=${() => {
              this._action = null;
            }}
            >Cancel</bridge-button
          >
          <bridge-button ?loading=${this._busy} @click=${() => this._submit(ACTIONS.UNSUSPEND)}
            >Unsuspend</bridge-button
          >
        </div>
      </bridge-dialog>
    `;
  }

  _open(action) {
    this._action = action;
    this._refundSession = '';
  }

  _openRefund(sessionId) {
    this._refundSession = sessionId;
    this._action = ACTIONS.REFUND;
  }

  async _submit(action) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (action === ACTIONS.SUSPEND) {
        await customersService.suspend(this.customerId);
        showToast({ kind: 'success', message: 'Suspended.' });
      } else if (action === ACTIONS.UNSUSPEND) {
        await customersService.unsuspend(this.customerId);
        showToast({ kind: 'success', message: 'Unsuspended.' });
      } else if (action === ACTIONS.REFUND) {
        await customersService.refund(this.customerId, {
          stripeSessionId: this._refundSession,
          reason: this._refundReason,
        });
        showToast({ kind: 'success', message: 'Refund initiated.' });
      }
      this._action = null;
      await this._load();
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : 'Action failed.' });
    } finally {
      this._busy = false;
    }
  }

  async _submitIssue() {
    const label = this._issueLabel.trim();
    if (!label) {
      showToast({ kind: 'warning', message: 'Label is required.' });
      return;
    }
    try {
      const created = await customersService.issueKey(this.customerId, label);
      this._issueOpen = false;
      this._newKey = created;
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to issue key.',
      });
    }
  }
}

function formatCents(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return (n / 100).toFixed(2);
}

if (!customElements.get('admin-customer-detail'))
  customElements.define('admin-customer-detail', AdminCustomerDetail);
