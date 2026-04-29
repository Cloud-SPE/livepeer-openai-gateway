import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-app.js';
import { accountService } from '../../lib/services/account.service.js';
import { keysService } from '../../lib/services/keys.service.js';
import { topupsService } from '../../lib/services/topups.service.js';
import { usageService } from '../../lib/services/usage.service.js';
import { api } from '../../lib/api.js';
import { session } from '../../lib/session.js';

const ACCOUNT = {
  id: 'c1',
  email: 'a@x.io',
  tier: 'prepaid',
  status: 'active',
  balance_usd: '5.00',
  reserved_usd: '0.00',
  free_tokens_remaining: null,
  free_tokens_reset_at: null,
  created_at: '2026-04-20T00:00:00.000Z',
};

beforeEach(() => {
  // Reset all singleton state between tests
  session.clear();
  accountService.signOut();
  keysService.reset();
  topupsService.reset();
  usageService.reset();
  location.hash = '';
});

afterEach(() => {
  sinon.restore();
  session.clear();
  location.hash = '';
});

describe('portal-app', () => {
  it('renders portal-login when no session is present', async () => {
    const el = await fixture(html`<portal-app></portal-app>`);
    expect(el.querySelector('portal-login')).to.exist;
    expect(el.querySelector('header.app-bar')).to.equal(null);
  });

  it('renders the app shell + dashboard when a session exists', async () => {
    session.set({ apiKey: 'sk-test-x', customerEmail: 'a@x.io' });
    sinon.stub(api, 'get').resolves(ACCOUNT);

    const el = await fixture(html`<portal-app></portal-app>`);
    await aTimeout(0);
    await el.updateComplete;

    expect(el.querySelector('header.app-bar')).to.exist;
    expect(el.querySelector('portal-dashboard')).to.exist;
    expect(el.textContent).to.contain('Livepeer Bridge');
  });

  it('responds to bridge:authenticated by switching to the app shell', async () => {
    sinon.stub(api, 'get').resolves(ACCOUNT);
    const el = await fixture(html`<portal-app></portal-app>`);
    expect(el.querySelector('portal-login')).to.exist;

    // Simulate sign-in finishing
    session.set({ apiKey: 'sk-test-x' });
    window.dispatchEvent(new CustomEvent('bridge:authenticated'));
    await aTimeout(0);
    await el.updateComplete;
    expect(el.querySelector('header.app-bar')).to.exist;
  });

  it('responds to bridge:unauthorized by signing the user out', async () => {
    session.set({ apiKey: 'sk-test-x' });
    sinon.stub(api, 'get').resolves(ACCOUNT);
    const el = await fixture(html`<portal-app></portal-app>`);
    await aTimeout(0);
    await el.updateComplete;

    window.dispatchEvent(new CustomEvent('bridge:unauthorized'));
    await aTimeout(0);
    await el.updateComplete;
    expect(el.querySelector('portal-login')).to.exist;
  });

  it('switches view on nav click via hash change', async () => {
    session.set({ apiKey: 'sk-test-x' });
    const stub = sinon.stub(api, 'get').resolves(ACCOUNT);
    // also stub key list for portal-keys connect
    stub.withArgs('/v1/account/api-keys').resolves({ keys: [] });

    const el = await fixture(html`<portal-app></portal-app>`);
    await aTimeout(0);
    await el.updateComplete;

    const navButtons = [...el.querySelectorAll('header.app-bar nav button')];
    const keysBtn = navButtons.find((b) => b.textContent.trim() === 'Keys');
    keysBtn.click();
    // navigate() sets location.hash → hashchange (async) → withViewTransition →
    // _view assignment → Lit re-render. Give the transition + render time.
    await aTimeout(80);
    await el.updateComplete;
    expect(el.querySelector('portal-keys')).to.exist;
  });

  it('shows tier pill and balance in the app bar', async () => {
    session.set({ apiKey: 'sk-test-x' });
    sinon.stub(api, 'get').resolves(ACCOUNT);
    const el = await fixture(html`<portal-app></portal-app>`);
    await aTimeout(0);
    await el.updateComplete;
    const bar = el.querySelector('header.app-bar');
    expect(bar.textContent).to.contain('prepaid');
    expect(bar.textContent).to.contain('$5.00');
  });

  it('Sign out clears session and shows login again', async () => {
    session.set({ apiKey: 'sk-test-x' });
    sinon.stub(api, 'get').resolves(ACCOUNT);
    const el = await fixture(html`<portal-app></portal-app>`);
    await aTimeout(0);
    await el.updateComplete;

    const signOutBtn = [...el.querySelectorAll('header.app-bar bridge-button')].find(
      (b) => b.textContent.trim() === 'Sign out',
    );
    expect(signOutBtn).to.exist;
    signOutBtn.click();
    await aTimeout(0);
    await el.updateComplete;
    expect(session.get()).to.equal(null);
    expect(el.querySelector('portal-login')).to.exist;
  });
});
