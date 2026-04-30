import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import '../../../../shared/components/bridge-confirm-dialog.js';

async function nextRender(el) {
  await el.updateComplete;
  // Some children update on next microtask
  await Promise.resolve();
  await el.updateComplete;
}

describe('bridge-confirm-dialog', () => {
  it('single-click mode: confirm button is enabled and emits bridge-confirm', async () => {
    const el = await fixture(html`
      <bridge-confirm-dialog
        heading="Revoke key?"
        body="This cannot be undone."
        confirm-label="Revoke"
        danger
      ></bridge-confirm-dialog>
    `);
    el.open = true;
    await nextRender(el);

    const confirmBtn = el.querySelectorAll('bridge-button')[1];
    expect(confirmBtn.textContent).to.contain('Revoke');
    expect(confirmBtn.disabled).to.equal(false);

    setTimeout(() => confirmBtn.click(), 0);
    const evt = await oneEvent(el, 'bridge-confirm');
    expect(evt).to.exist;
  });

  it('type-to-confirm: confirm disabled until input matches', async () => {
    const el = await fixture(html`
      <bridge-confirm-dialog
        heading="Suspend?"
        body="Type the email to confirm."
        required-text="user@example.com"
        confirm-label="Suspend"
        danger
      ></bridge-confirm-dialog>
    `);
    el.open = true;
    await nextRender(el);

    const confirmBtn = el.querySelectorAll('bridge-button')[1];
    expect(confirmBtn.disabled).to.equal(true);

    const input = el.querySelector('input.confirm-input');
    expect(input).to.exist;

    // Typed wrong
    input.value = 'user@wrong.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextRender(el);
    expect(confirmBtn.disabled).to.equal(true);

    // Typed exactly
    input.value = 'user@example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextRender(el);
    expect(confirmBtn.disabled).to.equal(false);
  });

  it('emits bridge-cancel and closes on cancel button click', async () => {
    const el = await fixture(html`<bridge-confirm-dialog></bridge-confirm-dialog>`);
    el.open = true;
    await nextRender(el);

    const cancelBtn = el.querySelectorAll('bridge-button')[0];
    setTimeout(() => cancelBtn.click(), 0);
    const evt = await oneEvent(el, 'bridge-cancel');
    expect(evt).to.exist;
    expect(el.open).to.equal(false);
  });

  it('clears typed text when re-opened', async () => {
    const el = await fixture(html`
      <bridge-confirm-dialog required-text="MATCH"></bridge-confirm-dialog>
    `);
    el.open = true;
    await nextRender(el);

    const input = el.querySelector('input.confirm-input');
    input.value = 'MATCH';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextRender(el);

    el.open = false;
    await nextRender(el);
    el.open = true;
    await nextRender(el);

    const reopened = el.querySelector('input.confirm-input');
    expect(reopened.value).to.equal('');
  });

  it('respects loading: confirm disabled even when text matches', async () => {
    const el = await fixture(html`
      <bridge-confirm-dialog required-text="OK"></bridge-confirm-dialog>
    `);
    el.open = true;
    el.loading = true;
    await nextRender(el);

    const input = el.querySelector('input.confirm-input');
    input.value = 'OK';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextRender(el);

    const confirmBtn = el.querySelectorAll('bridge-button')[1];
    expect(confirmBtn.disabled).to.equal(true);
  });
});
