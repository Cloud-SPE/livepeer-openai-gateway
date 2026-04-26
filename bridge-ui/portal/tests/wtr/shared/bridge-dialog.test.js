import { expect, fixture, html, aTimeout, oneEvent } from '@open-wc/testing';
import '../../../../shared/components/bridge-dialog.js';

describe('bridge-dialog', () => {
  it('opens and closes the underlying <dialog> when `open` toggles', async () => {
    const el = await fixture(html`<bridge-dialog heading="Hello"></bridge-dialog>`);
    const dialog = el.querySelector('dialog');
    expect(dialog).to.exist;
    expect(dialog.open).to.equal(false);

    el.open = true;
    await el.updateComplete;
    expect(dialog.open).to.equal(true);

    el.open = false;
    await el.updateComplete;
    expect(dialog.open).to.equal(false);
  });

  it('renders the heading slot when provided', async () => {
    const el = await fixture(html`<bridge-dialog heading="Confirm"></bridge-dialog>`);
    expect(el.querySelector('header h2').textContent.trim()).to.equal('Confirm');
  });

  it('omits header when heading is empty', async () => {
    const el = await fixture(html`<bridge-dialog></bridge-dialog>`);
    expect(el.querySelector('header')).to.equal(null);
  });

  it('emits bridge-close when the underlying dialog is closed', async () => {
    const el = await fixture(html`<bridge-dialog></bridge-dialog>`);
    el.open = true;
    await el.updateComplete;

    setTimeout(() => el.querySelector('dialog').close(), 0);
    const evt = await oneEvent(el, 'bridge-close');
    expect(evt).to.exist;
    expect(el.open).to.equal(false);
  });

  it('renders default + actions slots', async () => {
    const el = await fixture(html`
      <bridge-dialog heading="Title">
        <p data-test="body">Body text</p>
        <button slot="actions" data-test="action">OK</button>
      </bridge-dialog>
    `);
    expect(el.querySelector('[data-test="body"]')).to.exist;
    expect(el.querySelector('[data-test="action"]')).to.exist;
  });
});
