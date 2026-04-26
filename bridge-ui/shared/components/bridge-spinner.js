import { LitElement, html } from 'lit';
import { adoptStyles } from './_adopt-styles.js';

const STYLES = `
@layer components {
  bridge-spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  bridge-spinner svg {
    animation: bridge-spinner-rot 0.9s linear infinite;
    color: currentColor;
  }
  bridge-spinner svg circle {
    fill: none;
    stroke: currentColor;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-dasharray: 60;
    stroke-dashoffset: 20;
    opacity: 0.85;
  }
  @keyframes bridge-spinner-rot { to { transform: rotate(360deg); } }
}
`;

export class BridgeSpinner extends LitElement {
  static properties = {
    size: { type: String },
    label: { type: String },
  };

  constructor() {
    super();
    this.size = '20';
    this.label = 'Loading';
    adoptStyles('bridge-spinner', STYLES);
  }

  createRenderRoot() { return this; }

  render() {
    const s = this.size;
    return html`
      <svg width=${s} height=${s} viewBox="0 0 24 24" role="status" aria-label=${this.label}>
        <circle cx="12" cy="12" r="9"></circle>
      </svg>
    `;
  }
}

if (!customElements.get('bridge-spinner')) {
  customElements.define('bridge-spinner', BridgeSpinner);
}
