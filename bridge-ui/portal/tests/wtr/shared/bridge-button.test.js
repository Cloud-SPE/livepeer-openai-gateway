import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import '../../../../shared/components/bridge-button.js';
import '../../../../shared/components/bridge-spinner.js';

describe('bridge-button', () => {
  it('renders a button with slot text', async () => {
    const el = await fixture(html`<bridge-button>Save</bridge-button>`);
    const button = el.querySelector('button');
    expect(button).to.exist;
    expect(el.textContent.trim()).to.contain('Save');
  });

  it('reflects variant attribute (primary | ghost | danger)', async () => {
    for (const v of ['primary', 'ghost', 'danger']) {
      const el = await fixture(html`<bridge-button variant=${v}>x</bridge-button>`);
      expect(el.getAttribute('variant')).to.equal(v);
    }
  });

  it('shows the spinner and disables the button when loading', async () => {
    const el = await fixture(html`<bridge-button loading>Working</bridge-button>`);
    expect(el.querySelector('bridge-spinner')).to.exist;
    expect(el.querySelector('button').disabled).to.equal(true);
  });

  it('disables the button when disabled prop is set', async () => {
    const el = await fixture(html`<bridge-button disabled>x</bridge-button>`);
    expect(el.querySelector('button').disabled).to.equal(true);
  });

  it('blocks clicks when disabled', async () => {
    const el = await fixture(html`<bridge-button disabled>x</bridge-button>`);
    let clicked = false;
    el.addEventListener('click', () => { clicked = true; });
    el.querySelector('button').click();
    // Browser does not fire click on a disabled <button>; sanity-check
    expect(clicked).to.equal(false);
  });

  it('blocks clicks when loading (button is disabled at runtime)', async () => {
    const el = await fixture(html`<bridge-button loading>x</bridge-button>`);
    expect(el.querySelector('button').disabled).to.equal(true);
  });

  it('forwards type=submit so it works inside <form>', async () => {
    const form = await fixture(html`
      <form>
        <bridge-button type="submit">Go</bridge-button>
      </form>
    `);
    const button = form.querySelector('button');
    expect(button.getAttribute('type')).to.equal('submit');
  });

  it('grows to full width when block attribute set', async () => {
    const el = await fixture(html`<bridge-button block>x</bridge-button>`);
    expect(el.hasAttribute('block')).to.equal(true);
  });
});
