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
import { registerChatCompletionsRoute } from './completions.js';
import { createFakeV3PayerDaemon, createFakeV3ServiceRegistry } from '../testSupport/v3Harness.js';

let pg: TestPg;

type StreamMode =
  | { kind: 'ok' }
  | { kind: 'ok-no-usage' }
  | { kind: 'fail-500-immediately' }
  | { kind: 'slow'; interChunkMs: number };

interface FakeWorkerNode {
  app: FastifyInstance;
  port: number;
  setMode(m: StreamMode): void;
  close(): Promise<void>;
}

async function startFakeWorkerNode(): Promise<FakeWorkerNode> {
  let mode: StreamMode = { kind: 'ok' };
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as { stream?: boolean; stream_options?: { include_usage?: boolean } };
    if (!body.stream) {
      return reply.send({});
    }
    if (mode.kind === 'fail-500-immediately') {
      return reply.code(500).send({ error: 'node down' });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader('content-type', 'text/event-stream');
    raw.setHeader('cache-control', 'no-cache');
    raw.flushHeaders();

    const chunks = ['Hello', ' there', '.'];
    for (const c of chunks) {
      raw.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'model-small',
          choices: [{ index: 0, delta: { role: 'assistant', content: c }, finish_reason: null }],
        })}\n\n`,
      );
      if (mode.kind === 'slow') {
        await new Promise((r) => setTimeout(r, mode.interChunkMs));
      }
    }
    raw.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'model-small',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
    );

    if (mode.kind === 'ok' && body.stream_options?.include_usage) {
      raw.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'model-small',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}\n\n`,
      );
    }
    raw.write('data: [DONE]\n\n');
    raw.end();
  });

  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(addr.split(':').pop());
  return {
    app,
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
  state: { worker: FakeWorkerNode };
  stop(): Promise<void>;
}

async function startBridge(balanceCents = 10_000n): Promise<RunningBridge> {
  const worker = await startFakeWorkerNode();
  const customer = await customersRepo.insertCustomer(pg.db, {
    email: `str-${Math.random().toString(36).slice(2)}@x.io`,
    tier: 'prepaid',
    balanceUsdCents: balanceCents,
  });
  const pepper = 'stream-pepper-000000';
  const { plaintext } = await issueKey(pg.db, {
    customerId: customer.id,
    envPrefix: 'test',
    pepper,
  });

  const workerUrl = `http://127.0.0.1:${worker.port}`;
  const serviceRegistry = createFakeV3ServiceRegistry({
    id: 'node-str',
    url: workerUrl,
    capability: 'chat',
    offering: 'model-small',
    ethAddress: '0x00000000000000000000000000000000000000a1',
  });
  const nodeClient = createFetchNodeClient();
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 3, coolDownSeconds: 60 });
  const payerDaemon = createFakeV3PayerDaemon();
  const paymentsService = createPaymentsService({ payerDaemon });
  const nodeIndex = createNodeIndex([
    { id: 'node-str', url: workerUrl, capabilities: ['chat'], weight: 100 },
  ]);

  const authService = createAuthService({
    db: pg.db,
    config: { pepper, envPrefix: 'test', cacheTtlMs: 60_000 },
  });
  const server = await createFastifyServer({ logger: false });
  registerChatCompletionsRoute(server.app, {
    db: pg.db,
    serviceRegistry,
    nodeIndex,
    circuitBreaker,
    nodeClient,
    paymentsService,
    authResolver: createAuthResolver({ authService }),
    wallet: createPrepaidQuotaWallet({ db: pg.db }),
    pricing: testPricingProvider(),
    nodeCallTimeoutMs: 10_000,
  });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });

  return {
    url,
    customerId: customer.id,
    apiKey: plaintext,
    state: { worker },
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

async function collectStream(res: Response): Promise<{ frames: string[]; raw: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const frames = raw
    .split('\n\n')
    .map((f) => f.replace(/^data: /, '').trim())
    .filter((f) => f.length > 0);
  return { frames, raw };
}

describe('/v1/chat/completions streaming', () => {
  it('streams chunks + [DONE] and commits from upstream usage (usage stripped when customer did not request it)', async () => {
    const bridge = await startBridge();
    try {
      const res = await fetch(`${bridge.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({
          model: 'model-small',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 200,
        }),
      });
      expect(res.status).toBe(200);

      const { frames } = await collectStream(res);
      expect(frames[frames.length - 1]).toBe('[DONE]');
      const payloads = frames.slice(0, -1).map((f) => JSON.parse(f));
      // Customer did not ask for include_usage → no frame should carry a usage field.
      expect(payloads.every((p) => p.usage === undefined)).toBe(true);
      const content = payloads.map((p) => p.choices?.[0]?.delta?.content ?? '').join('');
      expect(content).toBe('Hello there.');

      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.balanceUsdCents).toBeLessThan(10_000n);
      expect(after!.reservedUsdCents).toBe(0n);
      const usage = await pg.db.execute(
        sql`SELECT status FROM engine.usage_records WHERE caller_id = ${bridge.customerId}`,
      );
      expect((usage.rows[0] as { status: string }).status).toBe('success');
    } finally {
      await bridge.stop();
    }
  });

  it('forwards the usage chunk when customer sets stream_options.include_usage=true', async () => {
    const bridge = await startBridge();
    try {
      const res = await fetch(`${bridge.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({
          model: 'model-small',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 200,
        }),
      });
      expect(res.status).toBe(200);
      const { frames } = await collectStream(res);
      const payloads = frames.slice(0, -1).map((f) => JSON.parse(f));
      const usageFrame = payloads.find((p) => p.usage !== undefined);
      expect(usageFrame).toBeDefined();
      expect(usageFrame.usage.total_tokens).toBe(8);
    } finally {
      await bridge.stop();
    }
  });

  it('OpenAI SDK streaming client drives the happy path end-to-end', async () => {
    const bridge = await startBridge();
    try {
      const client = new OpenAI({ baseURL: bridge.url + '/v1', apiKey: bridge.apiKey });
      const stream = await client.chat.completions.create({
        model: 'model-small',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        max_tokens: 200,
      });
      let text = '';
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? '';
      }
      expect(text).toBe('Hello there.');
    } finally {
      await bridge.stop();
    }
  });

  it('returns 503 + refunds when the upstream returns 500 before opening the stream', async () => {
    const bridge = await startBridge();
    bridge.state.worker.setMode({ kind: 'fail-500-immediately' });
    try {
      const res = await fetch(`${bridge.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({
          model: 'model-small',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 200,
        }),
      });
      expect(res.status).toBe(503);
      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.balanceUsdCents).toBe(10_000n);
      expect(after!.reservedUsdCents).toBe(0n);
    } finally {
      await bridge.stop();
    }
  });

  it('emits stream_terminated_early + partial-commit when upstream stream has no usage chunk', async () => {
    const bridge = await startBridge();
    bridge.state.worker.setMode({ kind: 'ok-no-usage' });
    try {
      const res = await fetch(`${bridge.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridge.apiKey}`,
        },
        body: JSON.stringify({
          model: 'model-small',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 200,
        }),
      });
      expect(res.status).toBe(200);
      const { frames } = await collectStream(res);
      // Final error frame with stream_terminated_early before [DONE].
      const errorFrame = frames
        .map((f) => {
          try {
            return JSON.parse(f);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.error);
      expect(errorFrame).toBeDefined();
      expect(errorFrame.error.type).toBe('StreamTerminatedEarly');

      const usage = await pg.db.execute(
        sql`SELECT status, error_code FROM engine.usage_records WHERE caller_id = ${bridge.customerId}`,
      );
      expect(usage.rows).toHaveLength(1);
      const row = usage.rows[0] as { status: string; error_code: string };
      expect(row.status).toBe('partial');
      expect(row.error_code).toBe('stream_terminated_early');

      const after = await customersRepo.findById(pg.db, bridge.customerId);
      expect(after!.reservedUsdCents).toBe(0n);
      expect(after!.balanceUsdCents).toBeLessThanOrEqual(10_000n);
    } finally {
      await bridge.stop();
    }
  });

  // Client-disconnect mid-stream settlement is implemented (req/reply.raw
  // 'close' → AbortController → streamSseEvents cancel → settle) but is hard
  // to prove deterministically against a real upstream — test coverage tracked
  // in tech-debt-tracker.md.
});
