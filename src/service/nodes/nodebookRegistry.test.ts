import { describe, expect, it } from 'vitest';
import { parseNodesYaml } from '../../config/nodes.js';
import { capabilityString } from '../../types/capability.js';
import type { Quote } from '../../types/node.js';
import { NodeBook } from './nodebook.js';
import { createNodeBookRegistry } from './nodebookRegistry.js';

function stubQuote(): Quote {
  return {
    ticketParams: {
      recipient: '0x' + 'aa'.repeat(20),
      faceValueWei: 1n,
      winProb: '0x01',
      recipientRandHash: '0x' + 'de'.repeat(32),
      seed: '0x' + 'be'.repeat(32),
      expirationBlock: 1n,
      expirationParams: {
        creationRound: 1n,
        creationRoundBlockHash: '0x' + 'ca'.repeat(32),
      },
    },
    priceInfo: { pricePerUnitWei: 1n, pixelsPerUnit: 1n },
    modelPrices: {},
    lastRefreshedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function seedAllQuotes(book: NodeBook): void {
  for (const entry of book.list()) {
    for (const cap of entry.config.capabilities) {
      book.setCapabilityQuote(entry.config.id, capabilityString(cap), stubQuote());
    }
  }
}

const addressA = '0x' + 'aa'.repeat(20);
const addressB = '0x' + 'bb'.repeat(20);

const yaml = `
nodes:
  - id: node-a
    url: https://node-a.example.com
    ethAddress: "${addressA}"
    supportedModels: ["model-small", "model-medium"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 50
  - id: node-b
    url: https://node-b.example.com
    ethAddress: "${addressB}"
    supportedModels: ["model-medium"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 200
`;

function buildRegistry() {
  const book = new NodeBook();
  book.replaceAll(parseNodesYaml(yaml));
  seedAllQuotes(book);
  return { book, registry: createNodeBookRegistry({ nodeBook: book }) };
}

describe('createNodeBookRegistry', () => {
  it('select returns nodes filtered by capability + model + tier, sorted by weight desc', async () => {
    const { registry } = buildRegistry();
    const result = await registry.select({
      capability: 'chat',
      model: 'model-medium',
      tier: 'prepaid',
    });
    const ids = result.map((r) => r.id);
    expect(ids).toEqual(['node-b', 'node-a']);
  });

  it('select honors excludeIds', async () => {
    const { registry } = buildRegistry();
    const result = await registry.select({
      capability: 'chat',
      model: 'model-medium',
      tier: 'prepaid',
      excludeIds: ['node-b'],
    });
    expect(result.map((r) => r.id)).toEqual(['node-a']);
  });

  it('select returns [] when no nodes match', async () => {
    const { registry } = buildRegistry();
    const result = await registry.select({
      capability: 'chat',
      model: 'no-such-model',
      tier: 'prepaid',
    });
    expect(result).toEqual([]);
  });

  it('select without model/tier returns capability-matching enabled non-circuit-broken nodes', async () => {
    const { registry } = buildRegistry();
    const result = await registry.select({ capability: 'chat' });
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(['node-a', 'node-b']);
  });

  it('listKnown without capability returns all nodes', async () => {
    const { registry } = buildRegistry();
    const result = await registry.listKnown();
    expect(result.map((r) => r.id).sort()).toEqual(['node-a', 'node-b']);
  });

  it('listKnown with capability filters', async () => {
    const { registry } = buildRegistry();
    const result = await registry.listKnown('chat');
    expect(result.map((r) => r.id).sort()).toEqual(['node-a', 'node-b']);
  });

  it('NodeRef carries config-derived fields and full NodeEntry as metadata', async () => {
    const { registry } = buildRegistry();
    const [first] = await registry.listKnown('chat');
    expect(first?.url).toMatch(/^https:\/\/node-/);
    expect(first?.weight).toBeGreaterThan(0);
    expect(first?.metadata).toBeDefined();
  });
});
