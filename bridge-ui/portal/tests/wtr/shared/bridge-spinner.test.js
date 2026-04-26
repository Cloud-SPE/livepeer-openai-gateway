import { expect, fixture, html } from '@open-wc/testing';
import '../../../../shared/components/bridge-spinner.js';

describe('bridge-spinner', () => {
  it('renders an SVG with role=status and the provided label', async () => {
    const el = await fixture(html`<bridge-spinner label="Saving"></bridge-spinner>`);
    const svg = el.querySelector('svg');
    expect(svg).to.exist;
    expect(svg.getAttribute('role')).to.equal('status');
    expect(svg.getAttribute('aria-label')).to.equal('Saving');
  });

  it('respects size prop on the SVG', async () => {
    const el = await fixture(html`<bridge-spinner size="32"></bridge-spinner>`);
    const svg = el.querySelector('svg');
    expect(svg.getAttribute('width')).to.equal('32');
    expect(svg.getAttribute('height')).to.equal('32');
  });

  it('defaults size and label when omitted', async () => {
    const el = await fixture(html`<bridge-spinner></bridge-spinner>`);
    const svg = el.querySelector('svg');
    expect(svg.getAttribute('width')).to.equal('20');
    expect(svg.getAttribute('aria-label')).to.equal('Loading');
  });
});
