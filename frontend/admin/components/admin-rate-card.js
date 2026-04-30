// Top-level retail-pricing page. Uses the shell-native v3 pricing
// surface, while the current runtime still consumes a compatibility
// adapter behind the scenes.

import { LitElement, html } from 'lit';
import { navigate } from '../../shared/lib/route.js';
import './admin-retail-pricing-capability.js';

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
        <h1>Retail pricing</h1>
        <p class="muted text-sm">
          Shell-native v3 pricing for all 5 capabilities. Edits take effect immediately for new
          requests. The current runtime still uses a legacy pricing adapter until the upstream v3
          protocol cut lands.
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
      <admin-retail-pricing-capability
        .capability=${active}
      ></admin-retail-pricing-capability>
    `;
  }
}

if (!customElements.get('admin-rate-card')) {
  customElements.define('admin-rate-card', AdminRateCard);
}
