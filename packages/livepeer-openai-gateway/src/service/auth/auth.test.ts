import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../billing/testPg.js';
import * as customersRepo from '../../repo/customers.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';
import {
  AccountClosedError,
  AccountSuspendedError,
  createAuthService,
  InvalidApiKeyError,
  issueKey,
  MalformedAuthorizationError,
  revokeKey,
} from './index.js';

let pg: TestPg;
const pepper = 'pepper-for-tests-1234567890';
const config = { pepper, envPrefix: 'test' as const, cacheTtlMs: 60_000 };

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, app.customers CASCADE`,
  );
});

async function seedActiveCustomer(): Promise<string> {
  const row = await customersRepo.insertCustomer(pg.db, {
    email: `auth-${Math.random().toString(36).slice(2)}@x.io`,
    tier: 'prepaid',
  });
  return row.id;
}

describe('service/auth', () => {
  it('issueKey + authenticate round-trip returns the customer and marks last_used_at', async () => {
    const customerId = await seedActiveCustomer();
    const { plaintext, apiKeyId } = await issueKey(pg.db, {
      customerId,
      envPrefix: 'test',
      pepper,
      label: 'primary',
    });

    const auth = createAuthService({ db: pg.db, config });
    const caller = await auth.authenticate(`Bearer ${plaintext}`);

    expect(caller.customer.id).toBe(customerId);
    expect(caller.apiKey.id).toBe(apiKeyId);
    expect(caller.apiKey.label).toBe('primary');

    // Give the fire-and-forget markUsed a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    const row = await apiKeysRepo.findById(pg.db, apiKeyId);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it('second call is served from cache without a fresh DB lookup', async () => {
    const customerId = await seedActiveCustomer();
    const { plaintext } = await issueKey(pg.db, { customerId, envPrefix: 'test', pepper });

    const auth = createAuthService({ db: pg.db, config });
    await auth.authenticate(`Bearer ${plaintext}`);
    expect(auth.cacheSize).toBe(1);
    const second = await auth.authenticate(`Bearer ${plaintext}`);
    expect(second.customer.id).toBe(customerId);
  });

  it('revokeKey causes authenticate to fail (after cache invalidation)', async () => {
    const customerId = await seedActiveCustomer();
    const { plaintext, apiKeyId } = await issueKey(pg.db, {
      customerId,
      envPrefix: 'test',
      pepper,
    });

    const auth = createAuthService({ db: pg.db, config });
    const first = await auth.authenticate(`Bearer ${plaintext}`);
    expect(first.customer.id).toBe(customerId);

    await revokeKey(pg.db, apiKeyId);
    // Invalidate cache explicitly — 60s TTL otherwise.
    auth.invalidate((await import('./keys.js')).hashApiKey(pepper, plaintext));

    await expect(auth.authenticate(`Bearer ${plaintext}`)).rejects.toBeInstanceOf(
      InvalidApiKeyError,
    );
  });

  it('rejects unknown keys with InvalidApiKeyError', async () => {
    const auth = createAuthService({ db: pg.db, config });
    const bogus = 'sk-test-' + 'a'.repeat(43);
    await expect(auth.authenticate(`Bearer ${bogus}`)).rejects.toBeInstanceOf(InvalidApiKeyError);
  });

  it('rejects suspended accounts with AccountSuspendedError', async () => {
    const customerId = await seedActiveCustomer();
    const { plaintext } = await issueKey(pg.db, { customerId, envPrefix: 'test', pepper });

    await pg.db.execute(
      sql`UPDATE app.customers SET status = 'suspended' WHERE id = ${customerId}`,
    );

    const auth = createAuthService({ db: pg.db, config });
    await expect(auth.authenticate(`Bearer ${plaintext}`)).rejects.toBeInstanceOf(
      AccountSuspendedError,
    );
  });

  it('rejects closed accounts with AccountClosedError', async () => {
    const customerId = await seedActiveCustomer();
    const { plaintext } = await issueKey(pg.db, { customerId, envPrefix: 'test', pepper });

    await pg.db.execute(sql`UPDATE app.customers SET status = 'closed' WHERE id = ${customerId}`);

    const auth = createAuthService({ db: pg.db, config });
    await expect(auth.authenticate(`Bearer ${plaintext}`)).rejects.toBeInstanceOf(
      AccountClosedError,
    );
  });

  it('rejects malformed Authorization headers', async () => {
    const auth = createAuthService({ db: pg.db, config });
    await expect(auth.authenticate(undefined)).rejects.toBeInstanceOf(MalformedAuthorizationError);
    await expect(auth.authenticate('Basic xyz')).rejects.toBeInstanceOf(
      MalformedAuthorizationError,
    );
    await expect(auth.authenticate('Bearer too many tokens here')).rejects.toBeInstanceOf(
      MalformedAuthorizationError,
    );
    await expect(auth.authenticate('Bearer not-a-key')).rejects.toBeInstanceOf(
      MalformedAuthorizationError,
    );
    await expect(auth.authenticate('Bearer ')).rejects.toBeInstanceOf(MalformedAuthorizationError);
  });

  it('error classes carry structured fields', () => {
    const susp = new AccountSuspendedError('cust-1');
    expect(susp.customerId).toBe('cust-1');
    expect(susp.code).toBe('authentication_failed');

    const closed = new AccountClosedError('cust-2');
    expect(closed.customerId).toBe('cust-2');

    const malformed = new MalformedAuthorizationError('bad');
    expect(malformed.detail).toBe('bad');
  });
});
