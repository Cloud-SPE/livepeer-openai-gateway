import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import { showToast } from '../../../../shared/components/bridge-toast.js';

describe('bridge-toast-stack', () => {
  it('renders a toast in response to showToast()', async () => {
    const el = await fixture(html`<bridge-toast-stack></bridge-toast-stack>`);
    showToast({ kind: 'success', message: 'Saved.' });
    await el.updateComplete;
    const toast = el.querySelector('.toast');
    expect(toast).to.exist;
    expect(toast.getAttribute('data-kind')).to.equal('success');
    expect(toast.textContent.trim()).to.equal('Saved.');
  });

  it('removes a toast after its ttl', async () => {
    const el = await fixture(html`<bridge-toast-stack></bridge-toast-stack>`);
    showToast({ kind: 'info', message: 'Quick', ttlMs: 50 });
    await el.updateComplete;
    expect(el.querySelectorAll('.toast').length).to.equal(1);
    await aTimeout(120);
    await el.updateComplete;
    expect(el.querySelectorAll('.toast').length).to.equal(0);
  });

  it('supports multiple toasts stacked', async () => {
    const el = await fixture(html`<bridge-toast-stack></bridge-toast-stack>`);
    showToast({ message: 'a', ttlMs: 0 });
    showToast({ message: 'b', ttlMs: 0 });
    showToast({ message: 'c', ttlMs: 0 });
    await el.updateComplete;
    expect(el.querySelectorAll('.toast').length).to.equal(3);
  });

  it('ignores malformed event detail', async () => {
    const el = await fixture(html`<bridge-toast-stack></bridge-toast-stack>`);
    window.dispatchEvent(new CustomEvent('bridge:toast', { detail: null }));
    window.dispatchEvent(new CustomEvent('bridge:toast'));
    await el.updateComplete;
    expect(el.querySelectorAll('.toast').length).to.equal(0);
  });
});
