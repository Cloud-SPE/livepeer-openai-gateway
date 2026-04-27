import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { createAuthService, issueKey } from '../../../service/auth/index.js';
import { createAuthResolver } from '../../../service/auth/authResolver.js';
import { createFastifyServer } from '@cloud-spe/bridge-core/providers/http/fastify.js';
import type { AuthenticatedCaller } from '../../../service/auth/authenticate.js';
import { authPreHandler } from '@cloud-spe/bridge-core/runtime/http/middleware/auth.js';

let pg: TestPg;
const pepper = 'pepper-for-http-tests-123';
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

async function buildServer() {
  const auth = createAuthService({ db: pg.db, config });
  const authResolver = createAuthResolver({ authService: auth });
  const server = await createFastifyServer({ logger: false });
  server.app.get('/whoami', { preHandler: authPreHandler(authResolver) }, async (req) => {
    const inner = req.caller?.metadata as AuthenticatedCaller | undefined;
    return { customerId: inner?.customer.id ?? null };
  });
  await server.app.ready();
  return server;
}

describe('runtime/http/middleware/auth (Fastify preHandler)', () => {
  it('returns 200 with a valid key and attaches the customer to the request', async () => {
    const customer = await customersRepo.insertCustomer(pg.db, {
      email: 'http@x.io',
      tier: 'prepaid',
    });
    const { plaintext } = await issueKey(pg.db, {
      customerId: customer.id,
      envPrefix: 'test',
      pepper,
    });

    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ customerId: customer.id });
    } finally {
      await server.close();
    }
  });

  it('returns 401 with an envelope when the key is unknown', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: 'Bearer sk-test-' + 'x'.repeat(43) },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('authentication_failed');
    } finally {
      await server.close();
    }
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({ method: 'GET', url: '/whoami' });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('returns 401 when the Authorization header is malformed', async () => {
    const server = await buildServer();
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: 'Bearer not-a-key' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});
