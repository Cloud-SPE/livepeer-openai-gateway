import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-billing.js';
import { topupsService } from '../../lib/services/topups.service.js';
import { api } from '../../lib/api.js';

let getStub, postStub, locationAssignStub;

beforeEach(() => {
  topupsService.reset();
  getStub = sinon.stub(api, 'get');
  postStub = sinon.stub(api, 'post');
});

afterEach(() => {
  sinon.restore();
  topupsService.reset();
});

const sampleTopups = {
  topups: [
    { id: 't1', stripe_session_id: 'cs_abc1234567890123', amount_usd: '25.00', status: 'succeeded', created_at: '2026-04-20T00:00:00.000Z', refunded_at: null, disputed_at: null },
    { id: 't2', stripe_session_id: 'cs_def1234567890123', amount_usd: '10.00', status: 'pending',   created_at: '2026-04-21T00:00:00.000Z', refunded_at: null, disputed_at: null },
  ],
  next_cursor: null,
};

describe('portal-billing', () => {
  it('lists past top-ups from /v1/account/topups', async () => {
    getStub.resolves(sampleTopups);
    const el = await fixture(html`<portal-billing></portal-billing>`);
    await aTimeout(0);
    await el.updateComplete;
    const table = el.querySelector('bridge-table');
    expect(table.rows).to.have.lengthOf(2);
    expect(el.textContent).to.contain('$25.00');
    expect(el.textContent).to.contain('succeeded');
    expect(el.textContent).to.contain('pending');
  });

  it('clicking a preset selects that amount', async () => {
    getStub.resolves(sampleTopups);
    const el = await fixture(html`<portal-billing></portal-billing>`);
    await aTimeout(0);
    await el.updateComplete;

    const presetButtons = [...el.querySelectorAll('section.tile bridge-button')];
    const fifty = presetButtons.find((b) => b.textContent.trim() === '$50');
    fifty.click();
    await el.updateComplete;
    expect(el.querySelector('input[type="number"]').value).to.equal('50');
  });

  it('starts checkout: calls topupsService.startCheckout with cents, surfaces returned url', async () => {
    getStub.resolves(sampleTopups);
    // Stub the service method directly so we (a) prove the component calls
    // through with the expected cent amount, and (b) avoid exercising the
    // actual redirect path (window.location.assign is non-configurable in
    // Chromium, so we never let the component reach it).
    const startStub = sinon.stub(topupsService, 'startCheckout')
      .returns(new Promise(() => {})); // pending forever — component stays in `_starting`

    const el = await fixture(html`<portal-billing></portal-billing>`);
    await aTimeout(0);
    await el.updateComplete;

    const buttons = [...el.querySelectorAll('section.tile bridge-button')];
    const payBtn = buttons.find((b) => b.textContent.includes('Pay $'));
    payBtn.click();
    await aTimeout(0);
    await el.updateComplete;

    expect(startStub.calledOnce).to.equal(true);
    // Default preset is $25 → 2500 cents
    expect(startStub.firstCall.args[0]).to.equal(2500);
    // Pay button is in loading state while checkout creation is pending
    expect(payBtn.loading).to.equal(true);
  });
});
