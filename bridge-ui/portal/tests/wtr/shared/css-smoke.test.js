// CSS smoke: verify the modern-CSS 2026 token catalogue actually resolves
// `light-dark()` to different values under `color-scheme: light` vs
// `color-scheme: dark`. This is the single test that confirms the OS-paired
// theming works — a regression here means the entire portal+admin will
// render the wrong palette.
//
// We don't test every token; we sample one surface, one text, one accent,
// one state. If those all flip, the catalogue is wired correctly.

import { expect, fixture, html } from '@open-wc/testing';

// Inject the shared tokens.css into the test document so :root tokens are
// defined when we read them. The shared CSS lives at ../../../../shared/css
// from this file.
async function loadSharedTokens() {
  if (document.head.querySelector('link[data-bridge-tokens]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/shared/css/tokens.css';
  link.setAttribute('data-bridge-tokens', 'true');
  document.head.appendChild(link);
  // Wait for stylesheet to apply
  await new Promise((resolve) => {
    link.onload = resolve;
    link.onerror = resolve;
    setTimeout(resolve, 200); // safety
  });
}

describe('CSS smoke: light-dark() resolution', () => {
  let lightHost, darkHost;

  before(async () => {
    await loadSharedTokens();
  });

  beforeEach(async () => {
    // Two sibling hosts that force their own color-scheme regardless of
    // the test runner's OS preference, so we can read each branch
    // independently.
    lightHost = await fixture(html`
      <div style="color-scheme: light"><span>x</span></div>
    `);
    darkHost = await fixture(html`
      <div style="color-scheme: dark"><span>x</span></div>
    `);
  });

  function rgb(el, prop) {
    return getComputedStyle(el).getPropertyValue(prop).trim();
  }

  it('--surface-1 resolves to different values under light vs dark', () => {
    const lightSurface = rgb(lightHost, 'background-color');
    const darkSurface = rgb(darkHost, 'background-color');
    // We need to actually read the resolved --surface-1, so apply it.
    lightHost.style.background = 'var(--surface-1)';
    darkHost.style.background = 'var(--surface-1)';
    const light = getComputedStyle(lightHost).backgroundColor;
    const dark = getComputedStyle(darkHost).backgroundColor;
    expect(light).to.not.equal(dark);
    expect(light).to.match(/^(rgb|oklch)/);
    expect(dark).to.match(/^(rgb|oklch)/);
  });

  it('--text-1 inverts: light is dark on light, dark is light on dark', () => {
    lightHost.style.color = 'var(--text-1)';
    darkHost.style.color = 'var(--text-1)';
    const light = getComputedStyle(lightHost).color;
    const dark = getComputedStyle(darkHost).color;
    expect(light).to.not.equal(dark);
  });

  it('--accent flips between light + dark variants', () => {
    lightHost.style.background = 'var(--accent)';
    darkHost.style.background = 'var(--accent)';
    expect(getComputedStyle(lightHost).backgroundColor).to.not.equal(
      getComputedStyle(darkHost).backgroundColor,
    );
  });

  it('--danger flips between light + dark variants', () => {
    lightHost.style.background = 'var(--danger)';
    darkHost.style.background = 'var(--danger)';
    expect(getComputedStyle(lightHost).backgroundColor).to.not.equal(
      getComputedStyle(darkHost).backgroundColor,
    );
  });

  it('color-mix() resolves on top of light-dark() (state derivations work)', () => {
    // --accent-hover = color-mix(in oklch, var(--accent), white 10%)
    // It must resolve to a real color in both branches; that's enough to
    // verify the chain (light-dark inside color-mix) compiles.
    lightHost.style.background = 'var(--accent-hover)';
    darkHost.style.background = 'var(--accent-hover)';
    const light = getComputedStyle(lightHost).backgroundColor;
    const dark = getComputedStyle(darkHost).backgroundColor;
    expect(light).to.not.equal('');
    expect(dark).to.not.equal('');
    expect(light).to.not.equal(dark);
  });
});
