// Top-level rate-card page. Sub-tab nav (chat / embeddings / images /
// speech / transcriptions) + per-capability child component. Per
// exec-plan 0030.

import { LitElement, html } from 'lit';
import { navigate } from '../../shared/lib/route.js';
import './admin-rate-card-chat.js';
import './admin-rate-card-embeddings.js';
import './admin-rate-card-images.js';
import './admin-rate-card-speech.js';
import './admin-rate-card-transcriptions.js';

const TABS = [
  { key: 'chat', label: 'Chat' },
  { key: 'embeddings', label: 'Embeddings' },
  { key: 'images', label: 'Images' },
  { key: 'speech', label: 'Speech' },
  { key: 'transcriptions', label: 'Transcriptions' },
];

export class AdminRateCard extends LitElement {
  static properties = {
    tab: { type: String },
  };

  constructor() {
    super();
    this.tab = 'chat';
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const active = TABS.some((t) => t.key === this.tab) ? this.tab : 'chat';
    return html`
      <div class="page-header">
        <h1>Rate card</h1>
        <p class="muted text-sm">
          Operator-managed pricing for all 5 capabilities. Edits take effect immediately for new
          requests; in-flight reservations honor the price quoted at reserve time.
        </p>
      </div>
      <nav
        class="sub-nav"
        style="display:flex; gap: var(--space-3); margin-bottom: var(--space-4); border-bottom: 1px solid var(--color-border);"
      >
        ${TABS.map(
          (t) => html`
            <button
              type="button"
              aria-current=${active === t.key ? 'page' : 'false'}
              class=${active === t.key ? 'sub-nav-active' : ''}
              style="padding: var(--space-2) var(--space-3); background: none; border: none; border-bottom: 2px solid ${active ===
              t.key
                ? 'var(--color-primary)'
                : 'transparent'}; cursor: pointer;"
              @click=${() => navigate(`rate-card/${t.key}`)}
            >
              ${t.label}
            </button>
          `,
        )}
      </nav>
      ${active === 'chat' ? html`<admin-rate-card-chat></admin-rate-card-chat>` : ''}
      ${active === 'embeddings'
        ? html`<admin-rate-card-embeddings></admin-rate-card-embeddings>`
        : ''}
      ${active === 'images' ? html`<admin-rate-card-images></admin-rate-card-images>` : ''}
      ${active === 'speech' ? html`<admin-rate-card-speech></admin-rate-card-speech>` : ''}
      ${active === 'transcriptions'
        ? html`<admin-rate-card-transcriptions></admin-rate-card-transcriptions>`
        : ''}
    `;
  }
}

if (!customElements.get('admin-rate-card')) {
  customElements.define('admin-rate-card', AdminRateCard);
}
