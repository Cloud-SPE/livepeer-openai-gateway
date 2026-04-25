import { describe, expect, it } from 'vitest';
import { parseNodesYaml } from '../../config/nodes.js';
import { capabilityString } from '../../types/capability.js';
import type { Quote } from '../../types/node.js';
import { NodeBook } from './nodebook.js';
import { NoHealthyNodesError } from './errors.js';

// Minimal Quote stub — values don't matter; tests assert routing
// shape, not payment math.
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

// Seeds a quote for every (node, advertised-capability) pair in the
// book. Mirrors what the refresher does after a successful /quotes
// probe; without this, post-0020 findNodesFor would exclude every
// node for lack of a quote.
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
  - id: node-c
    url: https://node-c.example.com
    ethAddress: "0x${'cc'.repeat(20)}"
    supportedModels: ["model-small"]
    enabled: false
    tierAllowed: ["free", "prepaid"]
    weight: 100
`;

describe('NodeBook', () => {
  it('filters by enabled / tier / model and sorts by weight descending', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    seedAllQuotes(book);

    const prepaidMedium = book.findNodesFor('model-medium', 'prepaid');
    expect(prepaidMedium.map((e) => e.config.id)).toEqual(['node-b', 'node-a']);

    const freeSmall = book.findNodesFor('model-small', 'free');
    expect(freeSmall.map((e) => e.config.id)).toEqual(['node-a']);
  });

  it('throws NoHealthyNodesError when nothing matches', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    seedAllQuotes(book);
    expect(() => book.findNodesFor('nonexistent', 'free')).toThrow(NoHealthyNodesError);
  });

  it('excludes circuit-broken nodes from results', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    seedAllQuotes(book);
    book.setCircuit('node-b', {
      status: 'circuit_broken',
      consecutiveFailures: 5,
      lastSuccessAt: null,
      lastFailureAt: new Date(),
      circuitOpenedAt: new Date(),
      halfOpenInFlight: false,
    });
    const prepaidMedium = book.findNodesFor('model-medium', 'prepaid');
    expect(prepaidMedium.map((e) => e.config.id)).toEqual(['node-a']);
  });

  it('defaults capability to chat so pre-capability callers match', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    seedAllQuotes(book);
    // yaml above omits `capabilities`; parser defaults to ['chat']
    const picks = book.findNodesFor('model-medium', 'prepaid');
    expect(picks.map((e) => e.config.id)).toEqual(['node-b', 'node-a']);
  });

  it('filters by capability when the caller asks for embeddings', () => {
    const book = new NodeBook();
    book.replaceAll(
      parseNodesYaml(`
nodes:
  - id: node-chat-only
    url: https://node-chat.example.com
    ethAddress: "${addressA}"
    supportedModels: ["text-embedding-3-small"]
    capabilities: ["chat"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 10
  - id: node-embeddings
    url: https://node-emb.example.com
    ethAddress: "${addressB}"
    supportedModels: ["text-embedding-3-small"]
    capabilities: ["embeddings"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 20
  - id: node-both
    url: https://node-both.example.com
    ethAddress: "0x${'dd'.repeat(20)}"
    supportedModels: ["text-embedding-3-small"]
    capabilities: ["chat", "embeddings"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 5
`),
    );
    seedAllQuotes(book);
    const picks = book.findNodesFor('text-embedding-3-small', 'prepaid', 'embeddings');
    expect(picks.map((e) => e.config.id).sort()).toEqual(['node-both', 'node-embeddings']);
  });

  it('throws NoHealthyNodesError when no node advertises the capability', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    seedAllQuotes(book);
    expect(() => book.findNodesFor('model-medium', 'prepaid', 'images')).toThrow(
      NoHealthyNodesError,
    );
  });

  it('preserves existing circuit state when configuration is replaced', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    seedAllQuotes(book);
    const now = new Date();
    book.setCircuit('node-a', {
      status: 'degraded',
      consecutiveFailures: 2,
      lastSuccessAt: now,
      lastFailureAt: now,
      circuitOpenedAt: null,
      halfOpenInFlight: false,
    });
    const snapshot = book.snapshot();
    book.replaceAll(parseNodesYaml(yaml), snapshot);
    expect(book.get('node-a')?.circuit.consecutiveFailures).toBe(2);
  });
});
