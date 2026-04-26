import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-usage.js';
import { usageService } from '../../lib/services/usage.service.js';
import { api } from '../../lib/api.js';

let getStub;

beforeEach(() => {
  usageService.reset();
  getStub = sinon.stub(api, 'get');
});

afterEach(() => {
  sinon.restore();
  usageService.reset();
});

const sampleUsage = {
  rows: [
    {
      bucket: '2026-04-22',
      prompt_tokens: 100,
      completion_tokens: 50,
      requests: 1,
      cost_usd: '0.05',
      status_breakdown: { success: 1, partial: 0, failed: 0 },
    },
  ],
  totals: { prompt_tokens: 100, completion_tokens: 50, requests: 1, cost_usd: '0.05' },
};

describe('portal-usage', () => {
  it('queries usage with default group_by=day on connect', async () => {
    getStub.resolves(sampleUsage);
    const el = await fixture(html`<portal-usage></portal-usage>`);
    await aTimeout(0);
    await el.updateComplete;
    expect(getStub.calledOnce).to.equal(true);
    expect(getStub.firstCall.args[0]).to.contain('group_by=day');
  });

  it('renders rows with totals once data arrives', async () => {
    getStub.resolves(sampleUsage);
    const el = await fixture(html`<portal-usage></portal-usage>`);
    await aTimeout(0);
    await el.updateComplete;

    expect(el.textContent).to.contain('1 requests');
    expect(el.textContent).to.contain('$0.05');
    const table = el.querySelector('bridge-table');
    expect(table.rows).to.have.lengthOf(1);
  });

  it('toggling group buttons fires a new query', async () => {
    getStub.resolves(sampleUsage);
    const el = await fixture(html`<portal-usage></portal-usage>`);
    await aTimeout(0);
    await el.updateComplete;

    const groupButtons = el.querySelectorAll('.page-header bridge-button');
    const modelBtn = [...groupButtons].find((b) => b.textContent.trim() === 'model');
    modelBtn.click();
    await aTimeout(0);
    await el.updateComplete;

    expect(getStub.callCount).to.equal(2);
    expect(getStub.secondCall.args[0]).to.contain('group_by=model');
  });

  it('header label changes with group_by selection', async () => {
    getStub.resolves(sampleUsage);
    const el = await fixture(html`<portal-usage></portal-usage>`);
    await aTimeout(0);
    await el.updateComplete;
    expect(el.textContent).to.contain('Date'); // default day

    const groupButtons = el.querySelectorAll('.page-header bridge-button');
    [...groupButtons].find((b) => b.textContent.trim() === 'capability').click();
    await aTimeout(0);
    await el.updateComplete;
    expect(el.textContent).to.contain('Capability');
  });
});
