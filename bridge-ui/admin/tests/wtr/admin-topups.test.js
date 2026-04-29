import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/admin-topups.js';
import { topupsService } from '../../lib/services/topups.service.js';
import { api } from '../../lib/api.js';

let getStub;

beforeEach(() => {
  topupsService.reset();
  getStub = sinon.stub(api, 'get').resolves({ topups: [], next_cursor: null });
});

afterEach(() => {
  sinon.restore();
  topupsService.reset();
});

describe('admin-topups', () => {
  it('queries with no filters on first connect', async () => {
    const el = await fixture(html`<admin-topups></admin-topups>`);
    await aTimeout(0);
    await el.updateComplete;
    expect(getStub.calledOnce).to.equal(true);
    const url = getStub.firstCall.args[0];
    expect(url).to.not.include('customer_id=');
    expect(url).to.not.include('status=');
  });

  it('selecting a status fires a new query with that status', async () => {
    const el = await fixture(html`<admin-topups></admin-topups>`);
    await aTimeout(0);
    await el.updateComplete;

    const select = el.querySelector('select');
    select.value = 'failed';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await aTimeout(0);
    await el.updateComplete;

    expect(getStub.callCount).to.equal(2);
    expect(getStub.secondCall.args[0]).to.contain('status=failed');
  });

  it('typing into the customer-id input fires a debounced query', async () => {
    const el = await fixture(html`<admin-topups></admin-topups>`);
    await aTimeout(0);
    await el.updateComplete;

    const input = el.querySelector('input[type="text"]');
    input.value = '12345678-aaaa-bbbb-cccc-1234567890ab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await aTimeout(350); // wait past debounce
    await el.updateComplete;

    expect(getStub.callCount).to.equal(2);
    expect(getStub.secondCall.args[0]).to.contain(
      'customer_id=12345678-aaaa-bbbb-cccc-1234567890ab',
    );
  });
});
