import { describe, expect, it } from 'vitest';
import { detectEthAddressChanges, parseNodesYaml } from './nodes.js';

const addressA = '0x' + 'aa'.repeat(20);
const addressB = '0x' + 'bb'.repeat(20);

const yamlOk = `
nodes:
  - id: node-a
    url: https://node-a.example.com
    ethAddress: "${addressA}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 100
    quoteRefreshSeconds: 15
    failureThreshold: 3
`;

describe('config/nodes', () => {
  it('parses valid YAML and applies defaults when optional knobs absent', () => {
    const cfg = parseNodesYaml(yamlOk);
    expect(cfg.nodes).toHaveLength(1);
    const node = cfg.nodes[0]!;
    expect(node.id).toBe('node-a');
    expect(node.refresh.quoteRefreshSeconds).toBe(15);
    expect(node.refresh.healthTimeoutMs).toBe(5_000);
    expect(node.breaker.failureThreshold).toBe(3);
    expect(node.breaker.coolDownSeconds).toBe(30);
  });

  it('defaults capabilities to [chat] when absent (backwards compat)', () => {
    const cfg = parseNodesYaml(yamlOk);
    expect(cfg.nodes[0]!.capabilities).toEqual(['chat']);
  });

  it('accepts an explicit capabilities list', () => {
    const cfg = parseNodesYaml(`
nodes:
  - id: node-multi
    url: https://node-multi.example.com
    ethAddress: "${addressA}"
    supportedModels: ["m1", "text-embedding-3-small"]
    capabilities: ["chat", "embeddings"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
`);
    expect(cfg.nodes[0]!.capabilities).toEqual(['chat', 'embeddings']);
  });

  it('rejects an empty capabilities array', () => {
    expect(() =>
      parseNodesYaml(`
nodes:
  - id: node-bad
    url: https://node.example.com
    ethAddress: "${addressA}"
    supportedModels: ["m"]
    capabilities: []
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
`),
    ).toThrow();
  });

  it('rejects an unknown capability', () => {
    expect(() =>
      parseNodesYaml(`
nodes:
  - id: node-bad
    url: https://node.example.com
    ethAddress: "${addressA}"
    supportedModels: ["m"]
    capabilities: ["chat", "telekinesis"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
`),
    ).toThrow();
  });

  it('rejects a malformed ethAddress', () => {
    expect(() =>
      parseNodesYaml(`
nodes:
  - id: node-bad
    url: https://node-b.example.com
    ethAddress: "0xNOTHEX"
    supportedModels: ["m"]
    enabled: true
    tierAllowed: ["free"]
    weight: 1
`),
    ).toThrow();
  });

  it('rejects an empty nodes list', () => {
    expect(() => parseNodesYaml('nodes: []')).toThrow();
  });

  it('detects eth_address changes across reloads (case-insensitive)', () => {
    const prev = parseNodesYaml(yamlOk);
    const next = parseNodesYaml(yamlOk.replace(addressA, addressB));
    const changes = detectEthAddressChanges(prev, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      nodeId: 'node-a',
      oldAddress: addressA,
      newAddress: addressB,
    });
  });

  it('does not flag a case-only difference in eth_address as a change', () => {
    const prev = parseNodesYaml(yamlOk);
    const upper = '0x' + addressA.slice(2).toUpperCase();
    const next = parseNodesYaml(yamlOk.replace(addressA, upper));
    expect(detectEthAddressChanges(prev, next)).toEqual([]);
  });

  it('returns no changes when a completely new node is added', () => {
    const prev = parseNodesYaml(yamlOk);
    const next = parseNodesYaml(`
nodes:
  - id: node-a
    url: https://node-a.example.com
    ethAddress: "${addressA}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 100
  - id: node-new
    url: https://node-c.example.com
    ethAddress: "${addressB}"
    supportedModels: ["model-medium"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 100
`);
    expect(detectEthAddressChanges(prev, next)).toEqual([]);
  });
});
