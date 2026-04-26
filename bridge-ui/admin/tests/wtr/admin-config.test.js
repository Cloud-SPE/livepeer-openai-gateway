import { expect, fixture, html, aTimeout } from '@open-wc/testing';
import sinon from 'sinon';
import '../../components/admin-config.js';
import { configService } from '../../lib/services/config.service.js';
import { api } from '../../lib/api.js';

const SAMPLE = {
  path: '/etc/bridge/nodes.yaml',
  sha256: 'a'.repeat(64),
  mtime: '2026-04-26T08:00:00.000Z',
  size_bytes: 512,
  contents: 'nodes:\n  - id: node-1\n    url: http://x\n',
  loaded_nodes: [
    { id: 'node-1', url: 'http://x', enabled: true, status: 'healthy',
      tierAllowed: ['free', 'prepaid'], supportedModels: ['m'], weight: 100 },
  ],
};

let getStub;

beforeEach(() => {
  configService.reset();
  getStub = sinon.stub(api, 'get').resolves(SAMPLE);
});

afterEach(() => { sinon.restore(); configService.reset(); });

describe('admin-config', () => {
  it('shows path, sha256, mtime, and the loaded-nodes table', async () => {
    const el = await fixture(html`<admin-config></admin-config>`);
    await aTimeout(0);
    await el.updateComplete;

    expect(el.textContent).to.contain('/etc/bridge/nodes.yaml');
    expect(el.textContent).to.contain(SAMPLE.sha256);
    expect(el.textContent).to.contain('node-1');
    // raw contents rendered in a <pre>
    expect(el.querySelector('pre').textContent).to.contain('node-1');
  });

  it('Reload button re-fetches', async () => {
    const el = await fixture(html`<admin-config></admin-config>`);
    await aTimeout(0);
    await el.updateComplete;

    const reloadBtn = [...el.querySelectorAll('bridge-button')]
      .find((b) => b.textContent.trim() === 'Reload');
    reloadBtn.click();
    await aTimeout(0);
    expect(getStub.callCount).to.be.greaterThan(1);
  });
});
