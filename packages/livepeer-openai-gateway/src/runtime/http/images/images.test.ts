import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { startTestPg, type TestPg } from '../../../service/billing/testPg.js';
import * as customersRepo from '../../../repo/customers.js';
import { createAuthService, issueKey } from '../../../service/auth/index.js';
import { createAuthResolver } from '../../../service/auth/authResolver.js';
import { createPrepaidQuotaWallet } from '../../../service/billing/wallet.js';
import { createPaymentsService } from '../../../service/payments/createPayment.js';
import { CircuitBreaker } from '@cloudspe/livepeer-openai-gateway-core/service/routing/circuitBreaker.js';
import { createNodeIndex } from '@cloudspe/livepeer-openai-gateway-core/service/routing/nodeIndex.js';
import { createFetchNodeClient } from '@cloudspe/livepeer-openai-gateway-core/providers/nodeClient/fetch.js';
import { createFastifyServer } from '@cloudspe/livepeer-openai-gateway-core/providers/http/fastify.js';
import { testPricingProvider } from '@cloudspe/livepeer-openai-gateway-core/service/pricing/testFixtures.js';
import { registerImagesGenerationsRoute } from './generations.js';
import { createFakeV3PayerDaemon, createFakeV3ServiceRegistry } from '../testSupport/v3Harness.js';

let pg: TestPg;

type ImagesMode = 'ok' | 'fail-500' | 'zero-images' | 'partial' | 'format-mismatch';

interface FakeWorkerNode {
  port: number;
  setMode(m: ImagesMode): void;
  close(): Promise<void>;
}

async function startFakeWorkerNode(): Promise<FakeWorkerNode> {
  let mode: ImagesMode = 'ok';
  const app: FastifyInstance = Fastify({ logger: false, disableRequestLogging: true });
  app.post('/v1/images/generations', async (req, reply) => {
    const body = req.body as {
      n?: number;
      response_format?: 'url' | 'b64_json';
    };
    const n = body.n ?? 1;
    if (mode === 'fail-500') return reply.code(500).send({ error: 'node down' });
    if (mode === 'zero-images') {
      return { created: Math.floor(Date.now() / 1000), data: [] };
    }
    const returnedCount = mode === 'partial' ? Math.max(1, n - 1) : n;
    const makeEntry = (i: number): { url?: string; b64_json?: string } => {
      if (mode === 'format-mismatch') {
        return { b64_json: 'x'.repeat(16) };
      }
      if (body.response_format === 'b64_json') {
        return { b64_json: 'x'.repeat(16) };
      }
      return { url: `https://example.com/img-${i}.png` };
    };
    return {
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: returnedCount }, (_, i) => makeEntry(i)),
    };
  });
  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(addr.split(':').pop());
  return {
    port,
    setMode(m) {
      mode = m;
    },
    async close() {
      await app.close();
    },
  };
}

interface RunningBridge {
  url: string;
  customerId: string;
  apiKey: string;
  worker: FakeWorkerNode;
  stop(): Promise<void>;
}

async function startBridge(opts: {
  customerTier: 'prepaid' | 'free';
  balanceCents?: bigint;
}): Promise<RunningBridge> {
  const worker = await startFakeWorkerNode();

  const customer = await customersRepo.insertCustomer(pg.db, {
    email: `e2e-img-${Math.random().toString(36).slice(2)}@x.io`,
    tier: opts.customerTier,
    ...(opts.customerTier === 'prepaid'
      ? { balanceUsdCents: opts.balanceCents ?? 10_000n }
      : { quotaTokensRemaining: 100_000n, quotaMonthlyAllowance: 100_000n }),
  });
  const pepper = 'e2e-pepper-0000000000';
  const { plaintext } = await issueKey(pg.db, {
    customerId: customer.id,
    envPrefix: 'test',
    pepper,
  });

  const workerUrl = `http://127.0.0.1:${worker.port}`;
  const serviceRegistry = createFakeV3ServiceRegistry({
    id: 'node-img',
    url: workerUrl,
    capability: 'images',
    offering: 'dall-e-3',
    ethAddress: '0x00000000000000000000000000000000000000f1',
  });
  const nodeClient = createFetchNodeClient();
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 3, coolDownSeconds: 60 });
  const payerDaemon = createFakeV3PayerDaemon();
  const paymentsService = createPaymentsService({ payerDaemon });
  const nodeIndex = createNodeIndex([
    { id: 'node-img', url: workerUrl, capabilities: ['images'], weight: 100 },
  ]);

  const authService = createAuthService({
    db: pg.db,
    config: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  const server = await createFastifyServer({ logger: false });
  registerImagesGenerationsRoute(server.app, {
    db: pg.db,
    serviceRegistry,
    nodeIndex,
    circuitBreaker,
    nodeClient,
    paymentsService,
    authResolver: createAuthResolver({ authService }),
    wallet: createPrepaidQuotaWallet({ db: pg.db }),
    pricing: testPricingProvider(),
  });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });

  return {
    url,
    customerId: customer.id,
    apiKey: plaintext,
    worker,
    async stop() {
      await server.close();
      await payerDaemon.close();
      await worker.close();
    },
  };
}

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(
    sql`TRUNCATE TABLE app.api_keys, app.reservations, engine.usage_records, app.topups, engine.node_health_events, engine.node_health, app.customers CASCADE`,
  );
});

describe('/v1/images/generations (end-to-end)', () => {
  it('prepaid happy path via OpenAI SDK: url passthrough, usage_record kind=images', async () => {
    const bridge = await startBridge({ customerTier: 'prepaid', balanceCents: 10_000n });
    try {
      const client = new OpenAI({ baseURL: bridge.url + '/v1', apiKey: bridge.apiKey });
      const res = await client.images.generate({
        model: 'dall-e-3',
        prompt: 'a cat',
        n: 1,
      });
      expect(res.data).toHaveLength(1);
      expect(res.data?.[0]?.url).toContain('example.com');

      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.reservedUsdCents).toBe(0n);
      // dall-e-3 1024x1024 standard (v2) = $0.025 → 3¢ (ceil); starting 10_000 → 9_997
      expect(after!.balanceUsdCents).toBe(9_997n);

      const usage = await pg.db.execute(
        sql`SELECT kind, image_count, status FROM engine.usage_records WHERE caller_id = ${bridge.customerId}`,
      );
      const row = usage.rows[0] as { kind: string; image_count: number; status: string };
      expect(row.kind).toBe('images');
      expect(row.image_count).toBe(1);
      expect(row.status).toBe('success');
    } finally {
      await bridge.stop();
    }
  });

  it('partial delivery: commits actual count, refunds delta, status=partial', async () => {
    const bridge = await startBridge({ customerTier: 'prepaid', balanceCents: 10_000n });
    bridge.worker.setMode('partial');
    try {
      const res = await fetch(`${bridge.url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({ model: 'dall-e-3', prompt: 'a cat', n: 3 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);

      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.reservedUsdCents).toBe(0n);
      // 2 × 3¢ = 6¢ billed (v2); reservation was 3 × 3¢ = 9¢; balance = 10_000 - 6 = 9_994
      expect(after!.balanceUsdCents).toBe(9_994n);

      const usage = await pg.db.execute(
        sql`SELECT image_count, status FROM engine.usage_records WHERE caller_id = ${bridge.customerId}`,
      );
      const row = usage.rows[0] as { image_count: number; status: string };
      expect(row.image_count).toBe(2);
      expect(row.status).toBe('partial');
    } finally {
      await bridge.stop();
    }
  });

  it('zero images returned: 503 + full refund', async () => {
    const bridge = await startBridge({ customerTier: 'prepaid', balanceCents: 10_000n });
    bridge.worker.setMode('zero-images');
    try {
      const res = await fetch(`${bridge.url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({ model: 'dall-e-3', prompt: 'a cat', n: 2 }),
      });
      expect(res.status).toBe(503);
      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.balanceUsdCents).toBe(10_000n);
      expect(after!.reservedUsdCents).toBe(0n);
    } finally {
      await bridge.stop();
    }
  });

  it('response_format mismatch: 503', async () => {
    const bridge = await startBridge({ customerTier: 'prepaid', balanceCents: 10_000n });
    bridge.worker.setMode('format-mismatch');
    try {
      const res = await fetch(`${bridge.url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: 'x',
          response_format: 'url',
        }),
      });
      expect(res.status).toBe(503);
      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.balanceUsdCents).toBe(10_000n);
    } finally {
      await bridge.stop();
    }
  });

  it('b64_json response format is passed through', async () => {
    const bridge = await startBridge({ customerTier: 'prepaid', balanceCents: 10_000n });
    try {
      const res = await fetch(`${bridge.url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: 'x',
          response_format: 'b64_json',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ b64_json?: string }> };
      expect(body.data[0]!.b64_json).toBeDefined();
    } finally {
      await bridge.stop();
    }
  });

  it('rejects free-tier with 402', async () => {
    const bridge = await startBridge({ customerTier: 'free' });
    try {
      const res = await fetch(`${bridge.url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({ model: 'dall-e-3', prompt: 'x' }),
      });
      expect(res.status).toBe(402);
    } finally {
      await bridge.stop();
    }
  });

  it('503 on node 500', async () => {
    const bridge = await startBridge({ customerTier: 'prepaid', balanceCents: 10_000n });
    bridge.worker.setMode('fail-500');
    try {
      const res = await fetch(`${bridge.url}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({ model: 'dall-e-3', prompt: 'x' }),
      });
      expect(res.status).toBe(503);
      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.balanceUsdCents).toBe(10_000n);
    } finally {
      await bridge.stop();
    }
  });
});
