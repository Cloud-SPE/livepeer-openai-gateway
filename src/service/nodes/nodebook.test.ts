import { describe, expect, it } from 'vitest';
import { parseNodesYaml } from '../../config/nodes.js';
import { NodeBook } from './nodebook.js';
import { NoHealthyNodesError } from './errors.js';

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

    const prepaidMedium = book.findNodesFor('model-medium', 'prepaid');
    expect(prepaidMedium.map((e) => e.config.id)).toEqual(['node-b', 'node-a']);

    const freeSmall = book.findNodesFor('model-small', 'free');
    expect(freeSmall.map((e) => e.config.id)).toEqual(['node-a']);
  });

  it('throws NoHealthyNodesError when nothing matches', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    expect(() => book.findNodesFor('nonexistent', 'free')).toThrow(NoHealthyNodesError);
  });

  it('excludes circuit-broken nodes from results', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
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
    const picks = book.findNodesFor('text-embedding-3-small', 'prepaid', 'embeddings');
    expect(picks.map((e) => e.config.id).sort()).toEqual(['node-both', 'node-embeddings']);
  });

  it('throws NoHealthyNodesError when no node advertises the capability', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
    expect(() => book.findNodesFor('model-medium', 'prepaid', 'images')).toThrow(
      NoHealthyNodesError,
    );
  });

  it('preserves existing circuit state when configuration is replaced', () => {
    const book = new NodeBook();
    book.replaceAll(parseNodesYaml(yaml));
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
