// Customer portal end-to-end test.
//
// Boots the bridge with TestPg + mocks on a real port, builds (or reuses) the
// portal SPA, and drives a real Chromium via Playwright through the sign-in
// flow + create-key flow + sign-out. The cleartext key is asserted to render
// exactly once. The test SKIPS gracefully if `bridge-ui/portal/dist/` is
// missing (fresh checkouts haven't built the UI yet) so server-only test
// runs aren't blocked.
//
// Selector note: the shared web components use light DOM (no shadow), and
// Lit preserves the original slotted children alongside the rendered
// template. The outer <bridge-button>...slotted text...</bridge-button>
// contains the visible text; the inner <button> rendered by Lit has an
// empty <slot>. So we filter at the bridge-button level
// (`bridge-button:has-text("Save")`) and click its descendant `button`.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { issueKey } from '../../../service/auth/keys.js';
import { createAuthService } from '../../../service/auth/index.js';
import { createAuthResolver } from '../../../service/auth/authResolver.js';
import { defaultRateLimitConfig } from '@cloudspe/livepeer-openai-gateway-core/config/rateLimit.js';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { registerAccountRoutes } from '../account/routes.js';
import { registerPortalStatic } from './static.js';

const PORTAL_DIST = resolve(process.cwd(), 'bridge-ui/portal/dist');
const HAS_DIST = existsSync(PORTAL_DIST);

const pepper = 'e2e-portal-pepper-0123456789ab';

let pg: TestPg;
let browser: Browser;
let bridge: { close(): Promise<void>; baseUrl: string } | null = null;

beforeAll(async () => {
  if (!HAS_DIST) return;
  pg = await startTestPg();
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  if (bridge) await bridge.close();
  if (browser) await browser.close();
  if (pg) await pg.close();
});

async function buildBridge() {
  const authService = createAuthService({
    db: pg.db,
    config: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  const server = await createFastifyServer({ logger: false });
  registerAccountRoutes(server.app, {
    db: pg.db,
    authResolver: createAuthResolver({ authService }),
    authConfig: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
    rateLimitConfig: defaultRateLimitConfig(),
  });
  await registerPortalStatic(server.app, { rootDir: PORTAL_DIST });
  // 0 = OS picks a free port
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  return {
    baseUrl: address,
    async close() {
      await server.close();
    },
  };
}

async function seedCustomerAndKey(opts: { email: string; tier?: 'free' | 'prepaid' }) {
  const customer = await customersRepo.insertCustomer(pg.db, {
    email: opts.email,
    tier: opts.tier ?? 'prepaid',
    balanceUsdCents: 1234n,
  });
  const { plaintext } = await issueKey(pg.db, {
    customerId: customer.id,
    envPrefix: 'test',
    pepper,
    label: 'e2e',
  });
  return { customer, plaintext };
}

describe.skipIf(!HAS_DIST)('portal E2E', () => {
  it('sign-in → dashboard render with seeded customer email + balance', async () => {
    await pg.db.execute(
      sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.stripe_webhook_events, app.customers CASCADE`,
    );
    const { plaintext } = await seedCustomerAndKey({ email: 'e2e-dash@example.com' });
    bridge = await buildBridge();

    const page = await browser.newPage();
    try {
      await page.goto(`${bridge.baseUrl}/portal/`, { waitUntil: 'domcontentloaded' });

      await page.waitForSelector('portal-login h1');
      const heading = await page.locator('portal-login h1').innerText();
      expect(heading).toBe('Sign in');

      await page.fill('input#apikey', plaintext);
      await page.locator('bridge-button:has-text("Sign in") button').click();

      // Dashboard mounts after auth
      await page.waitForSelector('portal-dashboard h1', { timeout: 5_000 });
      const welcome = await page.locator('portal-dashboard h1').innerText();
      expect(welcome).toContain('e2e-dash@example.com');

      // Tier pill in app bar (CSS text-transform: uppercase, so visible text is uppercase;
      // textContent is the raw value)
      const tier = await page.locator('header.app-bar .tier-pill').textContent();
      expect(tier?.trim()).toBe('prepaid');

      // Balance: $12.34 from balanceUsdCents=1234n
      const dashText = await page.locator('portal-dashboard').innerText();
      expect(dashText).toContain('$12.34');
    } finally {
      await page.close();
      await bridge.close();
      bridge = null;
    }
  }, 60_000);

  it('create-key flow: cleartext shown exactly once, persists after reload as a list row without the key', async () => {
    await pg.db.execute(
      sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.stripe_webhook_events, app.customers CASCADE`,
    );
    const { plaintext } = await seedCustomerAndKey({ email: 'e2e-keys@example.com' });
    bridge = await buildBridge();

    const page = await browser.newPage();
    try {
      await page.goto(`${bridge.baseUrl}/portal/`, { waitUntil: 'domcontentloaded' });
      await page.fill('input#apikey', plaintext);
      await page.locator('bridge-button:has-text("Sign in") button').click();
      await page.waitForSelector('portal-dashboard');

      // Navigate to keys page via the (native) nav button
      await page.locator('header.app-bar nav button:has-text("Keys")').click();
      await page.waitForSelector('portal-keys');

      // Open the create dialog (header has only one bridge-button)
      await page.locator('portal-keys .page-header bridge-button button').click();
      const labelInput = page.locator('portal-keys bridge-dialog input').first();
      await labelInput.waitFor();
      await labelInput.fill('e2e-issued');

      // Click "Create key" inside the dialog
      await page
        .locator('portal-keys bridge-dialog bridge-button:has-text("Create key") button')
        .click();

      // Cleartext banner appears
      await page.waitForSelector('portal-keys .new-key', { timeout: 5_000 });
      const cleartext = await page.locator('portal-keys .new-key code').innerText();
      expect(cleartext).toMatch(/^sk-test-[A-Za-z0-9_-]+$/);

      // Reload the page — hash (#keys) is preserved, so the keys page mounts
      // directly. Cleartext is gone, but the labeled row remains.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('portal-keys bridge-table', { timeout: 10_000 });
      const tableText = await page.locator('portal-keys bridge-table').innerText();
      expect(tableText).toContain('e2e-issued');
      expect(await page.locator('portal-keys .new-key').count()).toBe(0);
      // The cleartext value never re-appears anywhere
      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toContain(cleartext);
    } finally {
      await page.close();
      await bridge.close();
      bridge = null;
    }
  }, 60_000);

  it('sign-out clears session and the next reload renders the sign-in form again', async () => {
    await pg.db.execute(
      sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.stripe_webhook_events, app.customers CASCADE`,
    );
    const { plaintext } = await seedCustomerAndKey({ email: 'e2e-out@example.com' });
    bridge = await buildBridge();

    const page = await browser.newPage();
    try {
      await page.goto(`${bridge.baseUrl}/portal/`, { waitUntil: 'domcontentloaded' });
      await page.fill('input#apikey', plaintext);
      await page.locator('bridge-button:has-text("Sign in") button').click();
      await page.waitForSelector('portal-dashboard');

      // Click Sign out in the app bar
      await page.locator('header.app-bar bridge-button:has-text("Sign out") button').click();

      // Login form re-rendered
      await page.waitForSelector('portal-login h1');
      const heading = await page.locator('portal-login h1').innerText();
      expect(heading).toBe('Sign in');

      // Reload — still on sign-in (sessionStorage cleared)
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('portal-login h1');
      const headingAfter = await page.locator('portal-login h1').innerText();
      expect(headingAfter).toBe('Sign in');
    } finally {
      await page.close();
      await bridge.close();
      bridge = null;
    }
  }, 60_000);
});

if (!HAS_DIST) {
  console.warn(`[portal E2E] skipping: ${PORTAL_DIST} not built. Run \`npm run build:ui\` first.`);
}
