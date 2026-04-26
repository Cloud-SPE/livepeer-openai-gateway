import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/admin-audit.js';
import { auditService } from '../../lib/services/audit.service.js';
import { api } from '../../lib/api.js';

const sampleEvents = {
  events: [
    { id: 'e1', actor: 'alice', action: 'GET /admin/health', target_id: null,
      status_code: 200, occurred_at: '2026-04-26T08:00:00.000Z' },
    { id: 'e2', actor: 'bob', action: 'POST /admin/customers/c1/refund',
      target_id: 'c1', status_code: 200, occurred_at: '2026-04-26T08:01:00.000Z' },
  ],
  next_cursor: null,
};

let getStub;

beforeEach(() => {
  auditService.reset();
  getStub = sinon.stub(api, 'get').resolves(sampleEvents);
});

afterEach(() => { sinon.restore(); auditService.reset(); });

describe('admin-audit', () => {
  it('queries on connect and renders the feed', async () => {
    const el = await fixture(html`<admin-audit></admin-audit>`);
    await aTimeout(0);
    await el.updateComplete;
    expect(getStub.calledOnce).to.equal(true);
    expect(el.textContent).to.contain('alice');
    expect(el.textContent).to.contain('bob');
    expect(el.textContent).to.contain('/admin/health');
  });

  it('debounced filter on actor input', async () => {
    const el = await fixture(html`<admin-audit></admin-audit>`);
    await aTimeout(0);
    await el.updateComplete;
    const inputs = el.querySelectorAll('input[type="text"]');
    inputs[0].value = 'alice';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    await aTimeout(350);
    expect(getStub.callCount).to.equal(2);
    expect(getStub.secondCall.args[0]).to.contain('actor=alice');
  });

  it('clear button resets both filters and re-queries', async () => {
    const el = await fixture(html`<admin-audit></admin-audit>`);
    await aTimeout(0);
    await el.updateComplete;
    el.querySelectorAll('input[type="text"]')[0].value = 'alice';
    el.querySelectorAll('input[type="text"]')[0].dispatchEvent(new Event('input', { bubbles: true }));
    await aTimeout(350);

    const clearBtn = [...el.querySelectorAll('bridge-button')]
      .find((b) => b.textContent.trim() === 'Clear');
    clearBtn.click();
    await aTimeout(0);
    expect(getStub.lastCall.args[0]).to.not.include('actor=');
  });
});
