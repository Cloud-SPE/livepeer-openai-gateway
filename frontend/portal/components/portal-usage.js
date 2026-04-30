import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { usageService } from '../lib/services/usage.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-button.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-spinner.js';

export class PortalUsage extends LitElement {
  static properties = {
    _groupBy: { state: true },
  };

  constructor() {
    super();
    this.usage = new ObservableController(this, usageService.state$);
    this._groupBy = 'day';
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this._refresh();
  }

  async _refresh() {
    try {
      await usageService.query({ group_by: this._groupBy });
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load usage.',
      });
    }
  }

  render() {
    const s = this.usage.value;
    const data = s?.data ?? null;

    return html`
      <div class="page-header">
        <h1>Usage</h1>
        <div style="display: flex; gap: var(--space-2)">
          ${['day', 'model', 'capability'].map(
            (g) => html`
              <bridge-button
                variant=${this._groupBy === g ? 'primary' : 'ghost'}
                @click=${() => this._setGroup(g)}
                >${g}</bridge-button
              >
            `,
          )}
        </div>
      </div>

      ${s?.loading && !data ? html`<bridge-spinner></bridge-spinner>` : ''}
      ${data
        ? html`
            <p class="muted text-sm">
              ${data.totals.requests} requests · ${data.totals.prompt_tokens.toLocaleString()}
              prompt tokens · ${data.totals.completion_tokens.toLocaleString()} completion tokens ·
              $${data.totals.cost_usd}
            </p>
            <bridge-table
              .columns=${this._columns()}
              .rows=${data.rows}
              empty="No usage in this range."
            ></bridge-table>
          `
        : ''}
    `;
  }

  _columns() {
    const headerForGroup =
      this._groupBy === 'day' ? 'Date' : this._groupBy === 'model' ? 'Model' : 'Capability';
    return [
      { field: 'bucket', header: headerForGroup },
      { field: 'requests', header: 'Requests', render: (r) => r.requests.toLocaleString() },
      { field: 'prompt_tokens', header: 'Prompt', render: (r) => r.prompt_tokens.toLocaleString() },
      {
        field: 'completion_tokens',
        header: 'Completion',
        render: (r) => r.completion_tokens.toLocaleString(),
      },
      { field: 'cost_usd', header: 'Cost', render: (r) => `$${r.cost_usd}` },
    ];
  }

  async _setGroup(g) {
    this._groupBy = g;
    await this._refresh();
  }
}

if (!customElements.get('portal-usage')) customElements.define('portal-usage', PortalUsage);
