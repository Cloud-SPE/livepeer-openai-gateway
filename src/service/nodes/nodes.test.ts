import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import * as nodeHealthRepo from '../../repo/nodeHealth.js';
import { startTestPg, type TestPg } from '../billing/testPg.js';
import { createFetchNodeClient } from '../../providers/nodeClient/fetch.js';
import {
  TEST_BRIDGE_ETH,
  fakeHealthResponse,
  fakeQuoteResponse,
  fakeQuotesResponse,
} from '../../providers/nodeClient/testFakes.js';
import { createNodesLoader } from './loader.js';
import { createQuoteRefresher } from './quoteRefresher.js';
import { NodeBook } from './nodebook.js';
import { ManualScheduler } from './scheduler.js';
import { EthAddressChangedError } from './errors.js';

let pg: TestPg;

interface FakeNode {
  app: FastifyInstance;
  port: number;
  setHealthy(ok: boolean): void;
  setHealthDegraded(): void;
  setFailMode(mode: 'ok' | 'health-500' | 'quote-500'): void;
  close(): Promise<void>;
}

async function startFakeNode(): Promise<FakeNode> {
  let mode: 'ok' | 'health-500' | 'quote-500' = 'ok';
  let healthStatus: 'ok' | 'degraded' = 'ok';

  const app = Fastify({ logger: false, disableRequestLogging: true });
  app.get('/health', async (_req, reply) => {
    if (mode === 'health-500') {
      await reply.code(500).send({ error: 'down' });
      return;
    }
    return fakeHealthResponse({ status: healthStatus });
  });
  app.get('/quote', async (_req, reply) => {
    if (mode === 'quote-500') {
      await reply.code(500).send({ error: 'down' });
      return;
    }
    return fakeQuoteResponse();
  });
  app.get('/quotes', async (_req, reply) => {
    if (mode === 'quote-500') {
      await reply.code(500).send({ error: 'down' });
      return;
    }
    return fakeQuotesResponse();
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(address.split(':').pop());
  return {
    app,
    port,
    setHealthy(ok) {
      healthStatus = ok ? 'ok' : 'degraded';
    },
    setHealthDegraded() {
      healthStatus = 'degraded';
    },
    setFailMode(m) {
      mode = m;
    },
    async close() {
      await app.close();
    },
  };
}

function writeNodesYaml(dir: string, port: number, ethAddress: string): string {
  const p = path.join(dir, 'nodes.yaml');
  writeFileSync(
    p,
    `
nodes:
  - id: node-a
    url: http://127.0.0.1:${port}
    ethAddress: "${ethAddress}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 100
    quoteRefreshSeconds: 30
    failureThreshold: 3
    coolDownSeconds: 30
`,
  );
  return p;
}

beforeAll(async () => {
  pg = await startTestPg();
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.db.execute(sql`TRUNCATE TABLE node_health_event, node_health CASCADE`);
});

describe('nodes integration (Testcontainers + fake Fastify node)', () => {
  it('refresh cycle updates quote, records success, and persists state', async () => {
    const node = await startFakeNode();
    const dir = mkdtempSync(path.join(tmpdir(), 'nodes-'));
    const yamlPath = writeNodesYaml(dir, node.port, '0x' + 'aa'.repeat(20));

    const nodeBook = new NodeBook();
    const loader = createNodesLoader({ db: pg.db, nodeBook, configPath: yamlPath });
    loader.load();

    const scheduler = new ManualScheduler();
    scheduler.setNow(new Date('2026-05-01T00:00:00Z'));
    const refresher = createQuoteRefresher({
      db: pg.db,
      nodeBook,
      nodeClient: createFetchNodeClient(),
      scheduler,
      bridgeEthAddress: TEST_BRIDGE_ETH,
    });
    try {
      await refresher.tickNode('node-a');
      const entry = nodeBook.get('node-a');
      expect(entry?.circuit.status).toBe('healthy');
      const chatQuote = entry?.quotes.get('openai:/v1/chat/completions');
      expect(chatQuote).toBeDefined();
      expect(chatQuote?.priceInfo.pricePerUnitWei).toBe(1000n);

      const row = await nodeHealthRepo.findNodeHealth(pg.db, 'node-a');
      expect(row?.status).toBe('healthy');
    } finally {
      await node.close();
      refresher.stop();
    }
  });

  it('transitions closed → degraded → broken → half-open → closed', async () => {
    const node = await startFakeNode();
    const dir = mkdtempSync(path.join(tmpdir(), 'nodes-'));
    const yamlPath = writeNodesYaml(dir, node.port, '0x' + 'aa'.repeat(20));

    const nodeBook = new NodeBook();
    createNodesLoader({ db: pg.db, nodeBook, configPath: yamlPath }).load();

    const scheduler = new ManualScheduler();
    let nowMs = new Date('2026-05-01T00:00:00Z').getTime();
    scheduler.setNow(new Date(nowMs));

    const refresher = createQuoteRefresher({
      db: pg.db,
      nodeBook,
      nodeClient: createFetchNodeClient(),
      scheduler,
      bridgeEthAddress: TEST_BRIDGE_ETH,
    });

    try {
      node.setFailMode('health-500');
      for (let i = 0; i < 3; i++) {
        nowMs += 1000;
        scheduler.setNow(new Date(nowMs));
        await refresher.tickNode('node-a');
      }
      let entry = nodeBook.get('node-a');
      expect(entry?.circuit.status).toBe('circuit_broken');

      // During cool-down, a tick should not probe.
      nowMs += 5_000;
      scheduler.setNow(new Date(nowMs));
      await refresher.tickNode('node-a');
      expect(nodeBook.get('node-a')?.circuit.status).toBe('circuit_broken');

      // After cool-down with node recovered, probe succeeds → closed.
      node.setFailMode('ok');
      nowMs += 30_000;
      scheduler.setNow(new Date(nowMs));
      await refresher.tickNode('node-a');
      entry = nodeBook.get('node-a');
      expect(entry?.circuit.status).toBe('healthy');

      // Event log should contain open + half-open + closed transitions.
      const events = await nodeHealthRepo.listEventsForNode(pg.db, 'node-a');
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toContain('circuit_opened');
      expect(kinds).toContain('circuit_half_opened');
      expect(kinds).toContain('circuit_closed');
    } finally {
      await node.close();
      refresher.stop();
    }
  });

  it('reload rejects an eth_address mutation and logs the event', async () => {
    const node = await startFakeNode();
    const dir = mkdtempSync(path.join(tmpdir(), 'nodes-'));
    const addrA = '0x' + 'aa'.repeat(20);
    const addrB = '0x' + 'bb'.repeat(20);
    const yamlPath = writeNodesYaml(dir, node.port, addrA);

    const nodeBook = new NodeBook();
    const loader = createNodesLoader({ db: pg.db, nodeBook, configPath: yamlPath });
    loader.load();

    // Mutate eth_address in place.
    writeNodesYaml(dir, node.port, addrB);

    await expect(loader.reload()).rejects.toBeInstanceOf(EthAddressChangedError);

    const events = await nodeHealthRepo.listEventsForNode(pg.db, 'node-a');
    expect(events.some((e) => e.kind === 'eth_address_changed_rejected')).toBe(true);

    await node.close();
  });

  it('reload logs a config_reloaded event when eth_addresses are unchanged', async () => {
    const node = await startFakeNode();
    const dir = mkdtempSync(path.join(tmpdir(), 'nodes-'));
    const addr = '0x' + 'aa'.repeat(20);
    const yamlPath = writeNodesYaml(dir, node.port, addr);

    const nodeBook = new NodeBook();
    const loader = createNodesLoader({ db: pg.db, nodeBook, configPath: yamlPath });
    loader.load();

    writeNodesYaml(dir, node.port, addr); // same content
    await loader.reload();

    const events = await nodeHealthRepo.listEventsForNode(pg.db, 'node-a');
    expect(events.some((e) => e.kind === 'config_reloaded')).toBe(true);

    await node.close();
  });

  it('start / stop round-trip does not throw', async () => {
    const node = await startFakeNode();
    const dir = mkdtempSync(path.join(tmpdir(), 'nodes-'));
    const yamlPath = writeNodesYaml(dir, node.port, '0x' + 'aa'.repeat(20));

    const nodeBook = new NodeBook();
    createNodesLoader({ db: pg.db, nodeBook, configPath: yamlPath }).load();

    const scheduler = new ManualScheduler();
    const refresher = createQuoteRefresher({
      db: pg.db,
      nodeBook,
      nodeClient: createFetchNodeClient(),
      scheduler,
      bridgeEthAddress: TEST_BRIDGE_ETH,
    });

    refresher.start();
    refresher.start(); // idempotent
    refresher.stop();

    await node.close();
  });
});
