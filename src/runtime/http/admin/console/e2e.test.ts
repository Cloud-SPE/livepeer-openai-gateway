// Operator admin end-to-end test.
//
// Boots the bridge with TestPg + a mocked PayerDaemon + a stub
// ServiceRegistry on a real port, builds (or reuses) the admin SPA, and
// drives a real Chromium via Playwright through the operator sign-in +
// customer-detail suspend flow. Verifies that the X-Admin-Actor handle
// ends up in the admin_audit_event row that the action produces.
//
// Skips gracefully if `bridge-ui/admin/dist/` is missing (fresh checkouts
// haven't built the UI yet).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';
import { startTestPg, type TestPg } from '@cloud-spe/bridge-core/service/billing/testPg.js';
import * as customersRepo from '../../../../repo/customers.js';
import * as adminAuditEventsRepo from '../../../../repo/adminAuditEvents.js';
import { CircuitBreaker } from '@cloud-spe/bridge-core/service/routing/circuitBreaker.js';
import { createNodeIndex } from '@cloud-spe/bridge-core/service/routing/nodeIndex.js';
import { createFastifyServer } from '@cloud-spe/bridge-core/providers/http/fastify.js';
import { createAdminService } from '../../../../service/admin/index.js';
import { registerAdminRoutes } from '../routes.js';
import { registerAdminConsoleStatic } from './static.js';
import type { PayerDaemonClient } from '@cloud-spe/bridge-core/providers/payerDaemon.js';

const ADMIN_DIST = resolve(process.cwd(), 'bridge-ui/admin/dist');
const HAS_DIST = existsSync(ADMIN_DIST);

const ADMIN_TOKEN = 'a'.repeat(40);

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

function mockPayerDaemon(): PayerDaemonClient {
  return {
    async startSession() { return { workId: 'wrk' }; },
    async createPayment() { return { paymentBytes: new Uint8Array([1]), ticketsCreated: 1, expectedValueWei: 10n }; },
    async closeSession() { /* noop */ },
    async getDepositInfo() { return { depositWei: 1n, reserveWei: 1n, withdrawRound: 0n }; },
    isHealthy: () => true,
    startHealthLoop: () => undefined,
    stopHealthLoop: () => undefined,
    async close() { /* noop */ },
  };
}

async function buildBridge() {
  const nodeIndex = createNodeIndex([
    { id: 'node-e2e', url: 'http://127.0.0.1:9999', capabilities: ['chat'], weight: 100 },
  ]);
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 3, coolDownSeconds: 60 });
  const adminService = createAdminService({
    db: pg.db,
    payerDaemon: mockPayerDaemon(),
    nodeIndex,
    circuitBreaker,
  });
  const server = await createFastifyServer({ logger: false });
  registerAdminRoutes(server.app, {
    db: pg.db,
    config: { token: ADMIN_TOKEN, ipAllowlist: [] },
    adminService,
    authConfig: { pepper: 'admin-e2e-pepper-000', envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  await registerAdminConsoleStatic(server.app, { rootDir: ADMIN_DIST });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl: address, async close() { await server.close(); } };
}

describe.skipIf(!HAS_DIST)('admin E2E', () => {
  it('sign-in renders the health page with status tiles', async () => {
    await pg.db.execute(
      sql`TRUNCATE TABLE admin_audit_event, api_key, reservation, usage_record, topup, stripe_webhook_event, node_health_event, node_health, customer CASCADE`,
    );
    bridge = await buildBridge();
    const page = await browser.newPage();
    try {
      await page.goto(`${bridge.baseUrl}/admin/console/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('admin-login h1');
      const heading = await page.locator('admin-login h1').innerText();
      expect(heading).toBe('Operator sign-in');

      await page.fill('input#token', ADMIN_TOKEN);
      await page.fill('input#actor', 'alice');
      await page.locator('admin-login bridge-button:has-text("Sign in") button').click();

      // Health page mounts after auth
      await page.waitForSelector('admin-health', { timeout: 5_000 });
      const text = await page.locator('admin-health').innerText();
      expect(text).toContain('Fleet health');
      // Actor pill in app bar
      const actor = await page.locator('header.app-bar .actor-pill').innerText();
      expect(actor).toBe('alice');
    } finally {
      await page.close();
      await bridge.close();
      bridge = null;
    }
  }, 60_000);

  it('suspend a customer with type-to-confirm; audit row carries the actor handle', async () => {
    await pg.db.execute(
      sql`TRUNCATE TABLE admin_audit_event, api_key, reservation, usage_record, topup, stripe_webhook_event, node_health_event, node_health, customer CASCADE`,
    );
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'suspendme@example.com',
      tier: 'prepaid',
      balanceUsdCents: 5000n,
    });
    bridge = await buildBridge();
    const page = await browser.newPage();
    try {
      await page.goto(`${bridge.baseUrl}/admin/console/`, { waitUntil: 'domcontentloaded' });

      // Sign in as bob
      await page.fill('input#token', ADMIN_TOKEN);
      await page.fill('input#actor', 'bob');
      await page.locator('admin-login bridge-button:has-text("Sign in") button').click();
      await page.waitForSelector('admin-health');

      // Navigate directly to the customer detail page via hash
      await page.evaluate((id) => { location.hash = `#customers/${id}`; }, customer.id);
      await page.waitForSelector('admin-customer-detail h1', { timeout: 10_000 });
      await expect(
        await page.locator('admin-customer-detail h1').innerText(),
      ).toBe('suspendme@example.com');

      // Open suspend confirm dialog. Be specific about the danger variant —
      // the dialog's "Suspend" submit button (which renders later) also has
      // that text, but it's inside the dialog and we don't want to match it.
      await page
        .locator('admin-customer-detail .actions bridge-button[variant="danger"]:has-text("Suspend")')
        .click();
      // The bridge-confirm-dialog mounts when _action is set; wait for it
      // to actually be open (the open attribute reflects after the next render).
      await page.waitForFunction(
        () => {
          const d = document.querySelector('admin-customer-detail bridge-confirm-dialog');
          return d && d.hasAttribute('open');
        },
        { timeout: 5_000 },
      );

      // Confirm button is initially disabled (type-to-confirm guard)
      const confirmBtnSelector =
        'bridge-confirm-dialog[open] bridge-button:has-text("Suspend") button';
      const initiallyDisabled = await page
        .locator(confirmBtnSelector)
        .evaluate((b) => (b as HTMLButtonElement).disabled);
      expect(initiallyDisabled).toBe(true);

      // Type the customer email to enable confirm
      await page.fill(
        'bridge-confirm-dialog[open] input.confirm-input',
        'suspendme@example.com',
      );
      // Click confirm
      await page.locator(confirmBtnSelector).click();

      // Poll the DB until the suspend lands. UI re-render is best-effort;
      // the canonical proof is the customer row + audit row.
      const deadline = Date.now() + 10_000;
      let after = await customersRepo.findById(pg.db, customer.id);
      while (after?.status !== 'suspended' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        after = await customersRepo.findById(pg.db, customer.id);
      }
      expect(after?.status).toBe('suspended');

      // The audit row carries the X-Admin-Actor handle "bob"
      await new Promise((r) => setTimeout(r, 200));
      const audit = await adminAuditEventsRepo.search(pg.db, { limit: 50 });
      const suspendRow = audit.find((r) =>
        r.action.includes('/admin/customers/') && r.action.includes('suspend'),
      );
      expect(suspendRow).toBeDefined();
      expect(suspendRow?.actor).toBe('bob');
    } finally {
      await page.close();
      await bridge.close();
      bridge = null;
    }
  }, 60_000);
});

if (!HAS_DIST) {
  console.warn(
    `[admin E2E] skipping: ${ADMIN_DIST} not built. Run \`npm run build:ui\` first.`,
  );
}
