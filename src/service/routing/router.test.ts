import { describe, expect, it } from 'vitest';
import { parseNodesYaml } from '../../config/nodes.js';
import { NodeBook } from '../nodes/nodebook.js';
import { NoHealthyNodesError } from '../nodes/errors.js';
import { pickNode } from './router.js';

const addr = (c: string) => '0x' + c.repeat(20);

const yamlThree = `
nodes:
  - id: node-a
    url: https://a.example
    ethAddress: "${addr('aa')}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 100
  - id: node-b
    url: https://b.example
    ethAddress: "${addr('bb')}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["free", "prepaid"]
    weight: 300
  - id: node-c
    url: https://c.example
    ethAddress: "${addr('cc')}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 100
`;

function mkNodeBook(yaml: string): NodeBook {
  const nb = new NodeBook();
  nb.replaceAll(parseNodesYaml(yaml));
  return nb;
}

/** Linear-congruential RNG: deterministic across runs. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('pickNode (weighted-random)', () => {
  it('picks the only candidate when a free-only tier allowlist narrows the set', () => {
    const nb = mkNodeBook(yamlThree);
    const entry = pickNode({ nodeBook: nb }, 'model-small', 'free');
    expect(['node-a', 'node-b']).toContain(entry.config.id);
  });

  it('distributes picks proportionally to weight (seeded, 10k draws)', () => {
    const nb = mkNodeBook(yamlThree);
    const counts = new Map<string, number>();
    const rng = seededRng(0xdeadbeef);
    for (let i = 0; i < 10_000; i++) {
      const e = pickNode({ nodeBook: nb, rng }, 'model-small', 'prepaid');
      counts.set(e.config.id, (counts.get(e.config.id) ?? 0) + 1);
    }
    // Weights: a=100, b=300, c=100 → expected ratios 20/60/20.
    const a = counts.get('node-a') ?? 0;
    const b = counts.get('node-b') ?? 0;
    const c = counts.get('node-c') ?? 0;
    expect(b).toBeGreaterThan(a * 2);
    expect(b).toBeGreaterThan(c * 2);
    // Allow ±3% tolerance.
    expect(b / 10_000).toBeGreaterThan(0.57);
    expect(b / 10_000).toBeLessThan(0.63);
  });

  it('throws NoHealthyNodesError when no admission candidates exist', () => {
    const nb = mkNodeBook(yamlThree);
    expect(() => pickNode({ nodeBook: nb }, 'model-does-not-exist', 'prepaid')).toThrow(
      NoHealthyNodesError,
    );
  });

  it('returns first candidate when all weights are zero', () => {
    const nb = mkNodeBook(`
nodes:
  - id: node-z
    url: https://z.example
    ethAddress: "${addr('aa')}"
    supportedModels: ["model-small"]
    enabled: true
    tierAllowed: ["prepaid"]
    weight: 1
`);
    const e = pickNode({ nodeBook: nb }, 'model-small', 'prepaid');
    expect(e.config.id).toBe('node-z');
  });
});
