import { expect, fixture, html } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-dashboard.js';
import { accountService } from '../../lib/services/account.service.js';
import { api } from '../../lib/api.js';

beforeEach(() => {
  accountService.signOut();
});

afterEach(() => {
  sinon.restore();
  accountService.signOut();
});

describe('portal-dashboard', () => {
  it('shows a spinner while account$ is null', async () => {
    // Pending promise — service.refresh() never resolves during the test.
    sinon.stub(api, 'get').returns(new Promise(() => {}));
    const el = await fixture(html`<portal-dashboard></portal-dashboard>`);
    expect(el.querySelector('bridge-spinner')).to.exist;
  });

  it('renders balance + tier + welcome when account is loaded', async () => {
    accountService.set({
      id: 'c1',
      email: 'al@x.io',
      tier: 'prepaid',
      status: 'active',
      balance_usd: '42.50',
      reserved_usd: '0.00',
      free_tokens_remaining: null,
      free_tokens_reset_at: null,
      created_at: '2026-04-20T00:00:00.000Z',
    });
    const el = await fixture(html`<portal-dashboard></portal-dashboard>`);
    await el.updateComplete;
    expect(el.querySelector('h1').textContent).to.contain('al@x.io');
    expect(el.textContent).to.contain('$42.50');
    expect(el.textContent.toLowerCase()).to.contain('prepaid');
  });

  it('shows free-tier quota tile and reset time when tier=free', async () => {
    accountService.set({
      id: 'c2',
      email: 'free@x.io',
      tier: 'free',
      status: 'active',
      balance_usd: '0.00',
      reserved_usd: '0.00',
      free_tokens_remaining: 50000,
      free_tokens_reset_at: '2026-05-01T00:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const el = await fixture(html`<portal-dashboard></portal-dashboard>`);
    await el.updateComplete;
    expect(el.textContent).to.contain('50,000');
    expect(el.querySelector('.quota-bar .fill')).to.exist;
  });

  it('marks data-low=true when free-tier tokens are below 10k', async () => {
    accountService.set({
      id: 'c3',
      email: 'low@x.io',
      tier: 'free',
      status: 'active',
      balance_usd: '0.00',
      reserved_usd: '0.00',
      free_tokens_remaining: 1500,
      free_tokens_reset_at: '2026-05-01T00:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const el = await fixture(html`<portal-dashboard></portal-dashboard>`);
    await el.updateComplete;
    const lowEl = el.querySelector('[data-low="true"]');
    expect(lowEl).to.exist;
  });

  it('omits the quota tile for prepaid customers', async () => {
    accountService.set({
      id: 'c4',
      email: 'p@x.io',
      tier: 'prepaid',
      status: 'active',
      balance_usd: '5.00',
      reserved_usd: '0.00',
      free_tokens_remaining: null,
      free_tokens_reset_at: null,
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const el = await fixture(html`<portal-dashboard></portal-dashboard>`);
    await el.updateComplete;
    expect(el.querySelector('.quota-bar')).to.equal(null);
  });
});
