import { expect, fixture, html, oneEvent, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/portal-login.js';
import { session } from '../../lib/session.js';

let fetchStub;

beforeEach(() => {
  sessionStorage.clear();
  fetchStub = sinon.stub(window, 'fetch');
});

afterEach(() => {
  fetchStub.restore();
  session.clear();
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('portal-login', () => {
  it('renders the sign-in form with API key input', async () => {
    const el = await fixture(html`<portal-login></portal-login>`);
    expect(el.querySelector('h1').textContent.trim()).to.equal('Sign in');
    expect(el.querySelector('input[name="apikey"]')).to.exist;
    expect(el.querySelector('bridge-button[type="submit"]')).to.exist;
  });

  it('shows a validation error when submitting empty', async () => {
    const el = await fixture(html`<portal-login></portal-login>`);
    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await el.updateComplete;
    expect(el.querySelector('.error').textContent).to.contain('required');
  });

  it('on success: stores the session and emits bridge:authenticated', async () => {
    fetchStub.resolves(
      jsonResponse(200, {
        id: 'c1',
        email: 'a@x.io',
        tier: 'prepaid',
        status: 'active',
        balance_usd: '10.00',
        reserved_usd: '0.00',
        free_tokens_remaining: null,
        free_tokens_reset_at: null,
        created_at: '2026-04-20T00:00:00.000Z',
      }),
    );

    const el = await fixture(html`<portal-login></portal-login>`);
    const input = el.querySelector('input[name="apikey"]');
    input.value = 'sk-live-abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(
      () => el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })),
      0,
    );
    const evt = await oneEvent(window, 'bridge:authenticated');
    expect(evt).to.exist;

    const stored = session.get();
    expect(stored.apiKey).to.equal('sk-live-abc');
    expect(stored.customerEmail).to.equal('a@x.io');
  });

  it('on 401: shows the server error message and does not store session', async () => {
    fetchStub.resolves(
      jsonResponse(401, {
        error: { code: 'invalid_api_key', type: 'InvalidApiKeyError', message: 'invalid api key' },
      }),
    );

    const el = await fixture(html`<portal-login></portal-login>`);
    const input = el.querySelector('input[name="apikey"]');
    input.value = 'sk-live-bogus';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    // Wait for async submit to finish
    await aTimeout(20);
    await el.updateComplete;

    expect(el.querySelector('.error').textContent).to.contain('invalid api key');
    expect(session.get()).to.equal(null);
  });

  it('disables input and shows loading state during submit', async () => {
    let resolve;
    fetchStub.returns(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const el = await fixture(html`<portal-login></portal-login>`);
    el.querySelector('input[name="apikey"]').value = 'sk-live-pending';
    el.querySelector('input[name="apikey"]').dispatchEvent(new Event('input', { bubbles: true }));
    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await aTimeout(0);
    await el.updateComplete;

    expect(el.querySelector('input[name="apikey"]').disabled).to.equal(true);
    expect(el.querySelector('bridge-button').loading).to.equal(true);

    resolve(jsonResponse(401, { error: { message: 'no' } }));
    await aTimeout(20);
    await el.updateComplete;

    expect(el.querySelector('bridge-button').loading).to.equal(false);
  });
});
