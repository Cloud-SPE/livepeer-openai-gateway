import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import '../../../../shared/components/bridge-dialog.js';

// bridge-dialog uses shadow DOM (necessary for <slot> to project consumer
// content into the modal `<dialog>`). Tests query through `shadowRoot` for
// the inner template; slotted children stay in the host's light DOM.

describe('bridge-dialog', () => {
  it('opens and closes the underlying <dialog> when `open` toggles', async () => {
    const el = await fixture(html`<bridge-dialog heading="Hello"></bridge-dialog>`);
    const dialog = el.shadowRoot.querySelector('dialog');
    expect(dialog).to.exist;
    expect(dialog.open).to.equal(false);

    el.open = true;
    await el.updateComplete;
    expect(dialog.open).to.equal(true);

    el.open = false;
    await el.updateComplete;
    expect(dialog.open).to.equal(false);
  });

  it('renders the heading inside the shadow root when provided', async () => {
    const el = await fixture(html`<bridge-dialog heading="Confirm"></bridge-dialog>`);
    expect(el.shadowRoot.querySelector('header h2').textContent.trim()).to.equal('Confirm');
  });

  it('omits header when heading is empty', async () => {
    const el = await fixture(html`<bridge-dialog></bridge-dialog>`);
    expect(el.shadowRoot.querySelector('header')).to.equal(null);
  });

  it('emits bridge-close when the underlying dialog is closed', async () => {
    const el = await fixture(html`<bridge-dialog></bridge-dialog>`);
    el.open = true;
    await el.updateComplete;

    const dialog = el.shadowRoot.querySelector('dialog');
    setTimeout(() => dialog.close(), 0);
    const evt = await oneEvent(el, 'bridge-close');
    expect(evt).to.exist;
    expect(el.open).to.equal(false);
  });

  it('projects default + named slots into the shadow dialog', async () => {
    const el = await fixture(html`
      <bridge-dialog heading="Title">
        <p data-test="body">Body text</p>
        <button slot="actions" data-test="action">OK</button>
      </bridge-dialog>
    `);
    // Light-DOM children remain queryable on the host
    expect(el.querySelector('[data-test="body"]')).to.exist;
    expect(el.querySelector('[data-test="action"]')).to.exist;
    // And they're projected into the shadow root's <slot>s
    const defaultSlot = el.shadowRoot.querySelector('dialog > slot:not([name])');
    const actionsSlot = el.shadowRoot.querySelector('dialog footer slot[name="actions"]');
    expect(defaultSlot).to.exist;
    expect(actionsSlot).to.exist;
    const defaultAssigned = defaultSlot.assignedNodes({ flatten: true });
    const actionsAssigned = actionsSlot.assignedNodes({ flatten: true });
    expect(defaultAssigned.some((n) => n.dataset?.test === 'body')).to.equal(true);
    expect(actionsAssigned.some((n) => n.dataset?.test === 'action')).to.equal(true);
  });
});
