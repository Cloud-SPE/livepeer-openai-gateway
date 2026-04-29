import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-keys.js';
import { keysService } from '../../lib/services/keys.service.js';
import { api } from '../../lib/api.js';

let getStub, postStub, delStub;

beforeEach(() => {
  keysService.reset();
  getStub = sinon.stub(api, 'get');
  postStub = sinon.stub(api, 'post');
  delStub = sinon.stub(api, 'del');
});

afterEach(() => {
  sinon.restore();
  keysService.reset();
});

const sampleKeys = [
  {
    id: 'k-1',
    label: 'production',
    created_at: '2026-04-20T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
  },
  {
    id: 'k-2',
    label: 'staging',
    created_at: '2026-04-19T00:00:00.000Z',
    last_used_at: '2026-04-21T08:00:00.000Z',
    revoked_at: null,
  },
];

describe('portal-keys', () => {
  it('renders a spinner before keys$ has been populated', async () => {
    getStub.returns(new Promise(() => {})); // never resolves
    const el = await fixture(html`<portal-keys></portal-keys>`);
    expect(el.querySelector('bridge-spinner')).to.exist;
  });

  it('renders the keys list once keysService loads', async () => {
    getStub.resolves({ keys: sampleKeys });
    const el = await fixture(html`<portal-keys></portal-keys>`);
    await aTimeout(0);
    await el.updateComplete;
    const table = el.querySelector('bridge-table');
    expect(table).to.exist;
    expect(table.rows).to.have.lengthOf(2);
    expect(el.textContent).to.contain('production');
    expect(el.textContent).to.contain('staging');
  });

  it('opens the create dialog when "+ New key" is clicked', async () => {
    getStub.resolves({ keys: sampleKeys });
    const el = await fixture(html`<portal-keys></portal-keys>`);
    await aTimeout(0);
    await el.updateComplete;

    el.querySelector('.page-header bridge-button').click();
    await el.updateComplete;
    const dialog = el.querySelector('bridge-dialog');
    expect(dialog.open).to.equal(true);
  });

  it('creates a key and surfaces the cleartext exactly once', async () => {
    getStub.resolves({ keys: sampleKeys });
    postStub.resolves({
      id: 'k-new',
      label: 'fresh',
      key: 'sk-test-CLEARTEXT-VALUE',
      created_at: '2026-04-22T00:00:00.000Z',
    });

    const el = await fixture(html`<portal-keys></portal-keys>`);
    await aTimeout(0);
    await el.updateComplete;

    // open + type label + submit
    el.querySelector('.page-header bridge-button').click();
    await el.updateComplete;
    const labelInput = el.querySelector('bridge-dialog input');
    labelInput.value = 'fresh';
    labelInput.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const buttons = el.querySelectorAll('bridge-dialog bridge-button');
    const createBtn = [...buttons].find((b) => b.textContent.includes('Create'));
    createBtn.click();
    await aTimeout(0);
    await el.updateComplete;

    expect(postStub.calledOnceWith('/v1/account/api-keys', { label: 'fresh' })).to.equal(true);
    const banner = el.querySelector('.new-key');
    expect(banner).to.exist;
    expect(banner.textContent).to.contain('sk-test-CLEARTEXT-VALUE');
  });

  it('rejects empty label client-side', async () => {
    getStub.resolves({ keys: sampleKeys });
    const el = await fixture(html`<portal-keys></portal-keys>`);
    await aTimeout(0);
    await el.updateComplete;

    el.querySelector('.page-header bridge-button').click();
    await el.updateComplete;

    const buttons = el.querySelectorAll('bridge-dialog bridge-button');
    const createBtn = [...buttons].find((b) => b.textContent.includes('Create'));
    createBtn.click();
    await aTimeout(0);

    expect(postStub.notCalled).to.equal(true);
  });

  it('opens a confirm dialog when revoke is clicked, then revokes on confirm', async () => {
    // Two keys: revoking one is allowed (the other remains as the "active" set)
    getStub.resolves({ keys: sampleKeys });
    delStub.resolves(null);

    const el = await fixture(html`<portal-keys></portal-keys>`);
    await aTimeout(0);
    await el.updateComplete;

    // Click the revoke button in the first row
    const rowButtons = el.querySelectorAll('bridge-table tbody tr bridge-button');
    expect(rowButtons.length).to.be.greaterThan(0);
    rowButtons[0].click();
    await el.updateComplete;

    const confirm = el.querySelector('bridge-confirm-dialog');
    expect(confirm.open).to.equal(true);

    confirm.dispatchEvent(new CustomEvent('bridge-confirm'));
    await aTimeout(0);
    await el.updateComplete;

    expect(delStub.calledOnce).to.equal(true);
    expect(delStub.firstCall.args[0]).to.match(/^\/v1\/account\/api-keys\/k-/);
  });

  it('guards against revoking the only active key (assumes session = that key)', async () => {
    // Only one active key — revoking it should be blocked client-side
    const single = [
      {
        id: 'k-only',
        label: 'sole',
        created_at: '2026-04-20T00:00:00.000Z',
        last_used_at: null,
        revoked_at: null,
      },
    ];
    getStub.resolves({ keys: single });
    sessionStorage.setItem('bridge.portal.session', JSON.stringify({ apiKey: 'sk-test-anything' }));

    const el = await fixture(html`<portal-keys></portal-keys>`);
    await aTimeout(0);
    await el.updateComplete;

    el.querySelector('bridge-table tbody tr bridge-button').click();
    await el.updateComplete;
    const confirm = el.querySelector('bridge-confirm-dialog');
    expect(confirm.open).to.equal(true);

    confirm.dispatchEvent(new CustomEvent('bridge-confirm'));
    await aTimeout(0);

    // The component refuses to call DELETE when active count is 1
    expect(delStub.notCalled).to.equal(true);
    sessionStorage.clear();
  });
});
