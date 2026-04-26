import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/admin-customer-detail.js';
import { customersService } from '../../lib/services/customers.service.js';

const ACTIVE_CUSTOMER = {
  id: 'c-1',
  email: 'alice@example.com',
  tier: 'prepaid',
  status: 'active',
  balanceUsdCents: '1234',
  reservedUsdCents: '0',
  quotaTokensRemaining: null,
  quotaMonthlyAllowance: null,
  rateLimitTier: 'default',
  createdAt: '2026-04-20T00:00:00.000Z',
  topups: [
    { stripeSessionId: 'cs_first_succeeded_xxx', amountUsdCents: '2500', status: 'succeeded',
      createdAt: '2026-04-21T00:00:00.000Z', refundedAt: null, disputedAt: null },
  ],
  recentUsage: [],
};

const SUSPENDED_CUSTOMER = { ...ACTIVE_CUSTOMER, id: 'c-2', email: 'bob@example.com', status: 'suspended', topups: [] };

let selectStub, suspendStub, unsuspendStub, refundStub, issueKeyStub;

beforeEach(() => {
  selectStub = sinon.stub(customersService, 'select');
  suspendStub = sinon.stub(customersService, 'suspend');
  unsuspendStub = sinon.stub(customersService, 'unsuspend');
  refundStub = sinon.stub(customersService, 'refund');
  issueKeyStub = sinon.stub(customersService, 'issueKey');
});

afterEach(() => {
  sinon.restore();
});

async function mountWith(customer, id) {
  selectStub.resolves(customer);
  const el = await fixture(html`<admin-customer-detail .customerId=${id}></admin-customer-detail>`);
  // updated() triggers _load() asynchronously
  await aTimeout(0);
  await el.updateComplete;
  return el;
}

describe('admin-customer-detail', () => {
  it('renders email + tier + balance + status badge', async () => {
    const el = await mountWith(ACTIVE_CUSTOMER, 'c-1');
    expect(el.querySelector('h1').textContent).to.contain('alice@example.com');
    expect(el.textContent).to.contain('prepaid');
    expect(el.textContent).to.contain('12.34');
    expect(el.querySelector('.badge[data-status="active"]')).to.exist;
  });

  it('Suspend button exists for active customer; Unsuspend does not', async () => {
    const el = await mountWith(ACTIVE_CUSTOMER, 'c-1');
    const buttons = [...el.querySelectorAll('section.panel .actions bridge-button')];
    const labels = buttons.map((b) => b.textContent.trim());
    expect(labels).to.include('Suspend');
    expect(labels).to.not.include('Unsuspend');
  });

  it('Unsuspend button exists for suspended customer; Suspend does not', async () => {
    const el = await mountWith(SUSPENDED_CUSTOMER, 'c-2');
    const buttons = [...el.querySelectorAll('section.panel .actions bridge-button')];
    const labels = buttons.map((b) => b.textContent.trim());
    expect(labels).to.include('Unsuspend');
    expect(labels).to.not.include('Suspend');
  });

  it('Suspend flow: opens type-to-confirm dialog; confirm disabled until email matches', async () => {
    const el = await mountWith(ACTIVE_CUSTOMER, 'c-1');
    const suspendBtn = [...el.querySelectorAll('section.panel .actions bridge-button')]
      .find((b) => b.textContent.trim() === 'Suspend');
    suspendBtn.click();
    await aTimeout(0);
    await el.updateComplete;

    // The first bridge-confirm-dialog with required-text=email opens
    const dialog = [...el.querySelectorAll('bridge-confirm-dialog')]
      .find((d) => d.open && d.requiredText === 'alice@example.com');
    expect(dialog).to.exist;

    const buttons = dialog.querySelectorAll('bridge-button');
    const confirmBtn = buttons[1]; // [cancel, confirm]
    expect(confirmBtn.disabled).to.equal(true);

    const input = dialog.querySelector('input.confirm-input');
    input.value = 'alice@example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await aTimeout(0);
    await dialog.updateComplete;
    expect(confirmBtn.disabled).to.equal(false);

    suspendStub.resolves({ ok: true });
    confirmBtn.click();
    await aTimeout(20);
    await el.updateComplete;
    expect(suspendStub.calledOnceWith('c-1')).to.equal(true);
  });

  it('Refund flow: button present only when there are succeeded top-ups', async () => {
    const el = await mountWith(ACTIVE_CUSTOMER, 'c-1');
    const refundBtn = [...el.querySelectorAll('section.panel .actions bridge-button')]
      .find((b) => b.textContent.includes('Refund'));
    expect(refundBtn).to.exist;

    const noTopupsCustomer = { ...ACTIVE_CUSTOMER, id: 'c-3', topups: [] };
    selectStub.resetHistory();
    selectStub.resolves(noTopupsCustomer);
    const el2 = await fixture(html`<admin-customer-detail .customerId=${'c-3'}></admin-customer-detail>`);
    await aTimeout(0);
    await el2.updateComplete;
    const refundBtn2 = [...el2.querySelectorAll('section.panel .actions bridge-button')]
      .find((b) => b.textContent.includes('Refund'));
    expect(refundBtn2).to.equal(undefined);
  });

  it('Refund: type-to-confirm guard, then dispatches refund with the topup session id', async () => {
    const el = await mountWith(ACTIVE_CUSTOMER, 'c-1');
    const refundBtn = [...el.querySelectorAll('section.panel .actions bridge-button')]
      .find((b) => b.textContent.includes('Refund'));
    refundBtn.click();
    await aTimeout(0);
    await el.updateComplete;

    const refundDialog = [...el.querySelectorAll('bridge-confirm-dialog')]
      .find((d) => d.open && d.heading === 'Refund top-up?');
    expect(refundDialog).to.exist;

    const input = refundDialog.querySelector('input.confirm-input');
    input.value = 'alice@example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await aTimeout(0);
    await refundDialog.updateComplete;

    refundStub.resolves({ ok: true });
    const confirmBtn = refundDialog.querySelectorAll('bridge-button')[1];
    confirmBtn.click();
    await aTimeout(20);
    await el.updateComplete;

    expect(refundStub.calledOnce).to.equal(true);
    const args = refundStub.firstCall.args;
    expect(args[0]).to.equal('c-1');
    expect(args[1].stripeSessionId).to.equal('cs_first_succeeded_xxx');
  });

  it('Unsuspend: single-click confirm (no type-to-confirm guard)', async () => {
    const el = await mountWith(SUSPENDED_CUSTOMER, 'c-2');
    const unsuspendBtn = [...el.querySelectorAll('section.panel .actions bridge-button')]
      .find((b) => b.textContent.trim() === 'Unsuspend');
    unsuspendBtn.click();
    await aTimeout(0);
    await el.updateComplete;

    // The unsuspend uses a plain bridge-dialog (NOT type-to-confirm)
    const dialog = [...el.querySelectorAll('bridge-dialog')]
      .find((d) => d.open && d.heading.includes('Unsuspend'));
    expect(dialog).to.exist;

    const slot = dialog.querySelectorAll('bridge-button');
    const confirmBtn = [...slot].find((b) => b.textContent.trim() === 'Unsuspend');
    expect(confirmBtn).to.exist;
    expect(confirmBtn.disabled).to.equal(false); // no guard

    unsuspendStub.resolves({ ok: true });
    confirmBtn.click();
    await aTimeout(20);
    expect(unsuspendStub.calledOnceWith('c-2')).to.equal(true);
  });

  it('Issue key: opens dialog, posts label, surfaces cleartext exactly once', async () => {
    const el = await mountWith(ACTIVE_CUSTOMER, 'c-1');
    const issueBtn = [...el.querySelectorAll('section.panel .actions bridge-button')]
      .find((b) => b.textContent.trim() === 'Issue API key');
    issueBtn.click();
    await el.updateComplete;

    const dialog = [...el.querySelectorAll('bridge-dialog')]
      .find((d) => d.open && d.heading.includes('Issue API key'));
    expect(dialog).to.exist;

    const labelInput = dialog.querySelector('input');
    labelInput.value = 'op-issued';
    labelInput.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    issueKeyStub.resolves({ id: 'k-new', label: 'op-issued', key: 'sk-test-CLEAR', created_at: '2026-04-26T00:00:00.000Z' });
    const confirmBtn = [...dialog.querySelectorAll('bridge-button')]
      .find((b) => b.textContent.trim() === 'Issue key');
    confirmBtn.click();
    await aTimeout(20);
    await el.updateComplete;

    expect(issueKeyStub.calledOnceWith('c-1', 'op-issued')).to.equal(true);
    expect(el.textContent).to.contain('sk-test-CLEAR');
  });
});
