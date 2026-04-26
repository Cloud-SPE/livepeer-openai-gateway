import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/admin-reservations.js';
import { reservationsService } from '../../lib/services/reservations.service.js';
import { api } from '../../lib/api.js';

let getStub;

beforeEach(() => {
  reservationsService.reset();
  getStub = sinon.stub(api, 'get');
});

afterEach(() => { sinon.restore(); reservationsService.reset(); });

describe('admin-reservations', () => {
  it('queries open reservations on connect and renders the table', async () => {
    getStub.resolves({
      reservations: [
        { id: 'r1', customer_id: '12345678-aaaa-bbbb-cccc-1234567890ab', work_id: 'w-1',
          kind: 'prepaid', amount_usd_cents: '100', amount_tokens: null, state: 'open',
          created_at: '2026-04-26T08:00:00.000Z', age_seconds: 125 },
      ],
      next_cursor: null,
    });

    const el = await fixture(html`<admin-reservations></admin-reservations>`);
    await aTimeout(0);
    await el.updateComplete;

    expect(getStub.calledOnce).to.equal(true);
    expect(getStub.firstCall.args[0]).to.contain('state=open');
    const table = el.querySelector('bridge-table');
    expect(table.rows).to.have.lengthOf(1);
    expect(el.textContent).to.contain('2m 5s');
  });

  it('shows empty-state when no reservations are open', async () => {
    getStub.resolves({ reservations: [], next_cursor: null });
    const el = await fixture(html`<admin-reservations></admin-reservations>`);
    await aTimeout(0);
    await el.updateComplete;
    expect(el.textContent).to.contain('fleet is healthy');
  });
});
