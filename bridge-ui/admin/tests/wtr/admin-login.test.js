import { expect, fixture, html, oneEvent, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/admin-login.js';
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
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('admin-login', () => {
  it('renders the operator sign-in form', async () => {
    const el = await fixture(html`<admin-login></admin-login>`);
    expect(el.querySelector('h1').textContent).to.contain('Operator');
    expect(el.querySelector('input#token')).to.exist;
    expect(el.querySelector('input#actor')).to.exist;
  });

  it('rejects empty fields', async () => {
    const el = await fixture(html`<admin-login></admin-login>`);
    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await el.updateComplete;
    expect(el.querySelector('.error').textContent).to.contain('required');
  });

  it('rejects malformed actor handle (uppercase / special chars)', async () => {
    const el = await fixture(html`<admin-login></admin-login>`);
    el.querySelector('input#token').value = 'TOKEN';
    el.querySelector('input#token').dispatchEvent(new Event('input', { bubbles: true }));
    el.querySelector('input#actor').value = 'Alice!';
    el.querySelector('input#actor').dispatchEvent(new Event('input', { bubbles: true }));

    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await aTimeout(20);
    await el.updateComplete;
    expect(el.querySelector('.error').textContent).to.contain('actor must match');
    expect(session.get()).to.equal(null);
  });

  it('on success: stores session ({ token, actor }) and emits bridge:authenticated', async () => {
    fetchStub.resolves(jsonResponse(200, {
      ok: true, payerDaemonHealthy: true, dbOk: true, redisOk: true,
      nodeCount: 1, nodesHealthy: 1,
    }));
    const el = await fixture(html`<admin-login></admin-login>`);
    el.querySelector('input#token').value = 'admin-token';
    el.querySelector('input#token').dispatchEvent(new Event('input', { bubbles: true }));
    el.querySelector('input#actor').value = 'alice';
    el.querySelector('input#actor').dispatchEvent(new Event('input', { bubbles: true }));

    setTimeout(() => el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })), 0);
    const evt = await oneEvent(window, 'bridge:authenticated');
    expect(evt).to.exist;
    const stored = session.get();
    expect(stored.token).to.equal('admin-token');
    expect(stored.actor).to.equal('alice');

    // Validate auth headers were attached on the validation request
    const req = fetchStub.firstCall.args[1];
    expect(req.headers['x-admin-token']).to.equal('admin-token');
    expect(req.headers['x-admin-actor']).to.equal('alice');
  });

  it('on 401: surfaces error and does not store session', async () => {
    fetchStub.resolves(jsonResponse(401, { error: { message: 'invalid admin token' } }));
    const el = await fixture(html`<admin-login></admin-login>`);
    el.querySelector('input#token').value = 'bad';
    el.querySelector('input#token').dispatchEvent(new Event('input', { bubbles: true }));
    el.querySelector('input#actor').value = 'alice';
    el.querySelector('input#actor').dispatchEvent(new Event('input', { bubbles: true }));

    el.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await aTimeout(20);
    await el.updateComplete;
    expect(el.querySelector('.error').textContent).to.contain('invalid admin token');
    expect(session.get()).to.equal(null);
  });
});
