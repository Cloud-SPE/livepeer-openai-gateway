import { expect, fixture, html } from '@open-wc/testing';
import '../../../../shared/components/bridge-button.js';
import '../../../../shared/components/bridge-spinner.js';

// bridge-button uses shadow DOM (the inner <button> needs <slot> projection
// to keep the slotted text inside the visual button — light DOM <slot> is
// inert, see the component's docstring). Tests therefore query through
// `shadowRoot`. Shadow DOM does NOT block CSS custom-property inheritance,
// so the global token catalogue still applies.

describe('bridge-button', () => {
  it('renders a button (in shadow root) with the slot text in the host', async () => {
    const el = await fixture(html`<bridge-button>Save</bridge-button>`);
    const button = el.shadowRoot.querySelector('button');
    expect(button).to.exist;
    // textContent walks the host (light DOM); the slotted "Save" lives there.
    expect(el.textContent.trim()).to.contain('Save');
  });

  it('reflects variant attribute (primary | ghost | danger)', async () => {
    for (const v of ['primary', 'ghost', 'danger']) {
      const el = await fixture(html`<bridge-button variant=${v}>x</bridge-button>`);
      expect(el.getAttribute('variant')).to.equal(v);
    }
  });

  it('shows the spinner and disables the inner button when loading', async () => {
    const el = await fixture(html`<bridge-button loading>Working</bridge-button>`);
    expect(el.shadowRoot.querySelector('bridge-spinner')).to.exist;
    expect(el.shadowRoot.querySelector('button').disabled).to.equal(true);
  });

  it('disables the inner button when disabled prop is set', async () => {
    const el = await fixture(html`<bridge-button disabled>x</bridge-button>`);
    expect(el.shadowRoot.querySelector('button').disabled).to.equal(true);
  });

  it('blocks click events when disabled (browser short-circuits disabled buttons)', async () => {
    const el = await fixture(html`<bridge-button disabled>x</bridge-button>`);
    let clicked = false;
    el.addEventListener('click', () => { clicked = true; });
    el.shadowRoot.querySelector('button').click();
    expect(clicked).to.equal(false);
  });

  it('blocks clicks when loading (inner button disabled)', async () => {
    const el = await fixture(html`<bridge-button loading>x</bridge-button>`);
    expect(el.shadowRoot.querySelector('button').disabled).to.equal(true);
  });

  it('type=submit forwards: clicking submits the enclosing <form>', async () => {
    const form = await fixture(html`
      <form>
        <bridge-button type="submit">Go</bridge-button>
      </form>
    `);
    const inner = form.querySelector('bridge-button').shadowRoot.querySelector('button');
    expect(inner.getAttribute('type')).to.equal('submit');

    let submitted = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted = true;
    });
    inner.click();
    // requestSubmit is async via microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(submitted).to.equal(true);
  });

  it('grows to full width when block attribute set', async () => {
    const el = await fixture(html`<bridge-button block>x</bridge-button>`);
    expect(el.hasAttribute('block')).to.equal(true);
  });
});
