import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-settings.js';
import { accountService } from '../../lib/services/account.service.js';
import { api } from '../../lib/api.js';

beforeEach(() => {
  accountService.signOut();
});

afterEach(() => {
  sinon.restore();
  accountService.signOut();
});

describe('portal-settings', () => {
  it('shows a spinner before account$ resolves', async () => {
    sinon.stub(api, 'get').resolves(null);
    const el = await fixture(html`<portal-settings></portal-settings>`);
    expect(el.querySelector('bridge-spinner')).to.exist;
  });

  it('renders account fields and rate-limit fields once data is loaded', async () => {
    accountService.set({
      id: 'c1',
      email: 'who@x.io',
      tier: 'free',
      status: 'active',
      balance_usd: '0.00',
      reserved_usd: '0.00',
      free_tokens_remaining: 50_000,
      free_tokens_reset_at: '2026-05-01T00:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    sinon.stub(api, 'get').resolves({
      tier: 'free',
      max_concurrent: 1,
      requests_per_minute: 3,
      max_tokens_per_request: 1024,
      monthly_token_quota: 100_000,
    });

    const el = await fixture(html`<portal-settings></portal-settings>`);
    await aTimeout(0);
    await el.updateComplete;

    expect(el.textContent).to.contain('who@x.io');
    expect(el.textContent.toLowerCase()).to.contain('free');
    // Rate limit values — formatted with locale grouping
    expect(el.textContent).to.contain('1,024');
    expect(el.textContent).to.contain('100,000');
  });

  it("shows 'unlimited' when monthly quota is null", async () => {
    accountService.set({
      id: 'c2',
      email: 'p@x.io',
      tier: 'prepaid',
      status: 'active',
      balance_usd: '5.00',
      reserved_usd: '0.00',
      free_tokens_remaining: null,
      free_tokens_reset_at: null,
      created_at: '2026-04-01T00:00:00.000Z',
    });
    sinon.stub(api, 'get').resolves({
      tier: 'prepaid',
      max_concurrent: 10,
      requests_per_minute: 60,
      max_tokens_per_request: 32768,
      monthly_token_quota: null,
    });

    const el = await fixture(html`<portal-settings></portal-settings>`);
    await aTimeout(0);
    await el.updateComplete;
    expect(el.textContent).to.contain('unlimited');
  });
});
