import { LitElement, html } from 'lit';
import { ObservableController } from '../../shared/controllers/observable-controller.js';
import { configService } from '../lib/services/config.service.js';
import { showToast } from '../../shared/components/bridge-toast.js';

import '../../shared/components/bridge-spinner.js';
import '../../shared/components/bridge-table.js';
import '../../shared/components/bridge-button.js';

export class AdminConfig extends LitElement {
  constructor() {
    super();
    this.state = new ObservableController(this, configService.state$);
  }

  createRenderRoot() {
    return this;
  }

  async connectedCallback() {
    super.connectedCallback();
    if (!configService.value) await this._refresh();
  }

  async _refresh() {
    try {
      await configService.refresh();
    } catch (err) {
      showToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load nodes.yaml.',
      });
    }
  }

  render() {
    const s = this.state.value;
    if (!s) return html`<bridge-spinner></bridge-spinner>`;
    return html`
      <div class="page-header">
        <h1>nodes.yaml</h1>
        <bridge-button variant="ghost" @click=${() => this._refresh()}>Reload</bridge-button>
      </div>

      <section
        style="background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-lg); padding: var(--space-5); margin-bottom: var(--space-5)"
      >
        <dl
          style="display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-4); margin: 0"
        >
          <dt class="muted text-sm">Path</dt>
          <dd class="mono text-xs" style="margin: 0">${s.path}</dd>
          <dt class="muted text-sm">SHA-256</dt>
          <dd class="mono text-xs" style="margin: 0">${s.sha256}</dd>
          <dt class="muted text-sm">Modified</dt>
          <dd style="margin: 0">${new Date(s.mtime).toLocaleString()}</dd>
          <dt class="muted text-sm">Size</dt>
          <dd style="margin: 0">${s.size_bytes} bytes</dd>
        </dl>
      </section>

      <h2 style="margin: 0 0 var(--space-3)">Loaded nodes</h2>
      <bridge-table
        .columns=${this._loadedColumns()}
        .rows=${s.loaded_nodes}
        empty="No nodes loaded."
      ></bridge-table>

      <h2 style="margin: var(--space-6) 0 var(--space-3)">Raw contents</h2>
      <pre
        style="background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--radius-md); padding: var(--space-4); overflow-x: auto; font-size: var(--font-size-sm); white-space: pre-wrap; word-break: break-word"
      >
${s.contents}</pre
      >
    `;
  }

  _loadedColumns() {
    return [
      { field: 'id', header: 'ID' },
      {
        field: 'url',
        header: 'URL',
        render: (n) => html`<span class="mono text-xs">${n.url}</span>`,
      },
      {
        field: 'enabled',
        header: 'Enabled',
        render: (n) => (n.enabled ? 'yes' : html`<span class="muted">no</span>`),
      },
      { field: 'tierAllowed', header: 'Tier', render: (n) => (n.tierAllowed ?? []).join(', ') },
      { field: 'weight', header: 'Weight' },
    ];
  }
}

if (!customElements.get('admin-config')) customElements.define('admin-config', AdminConfig);
