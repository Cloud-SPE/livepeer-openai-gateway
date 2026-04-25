import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import type { CustomerTier } from '../../types/customer.js';
import type { NodeCapability } from '../../types/node.js';

export interface PickNodeDeps {
  nodeBook: NodeBook;
  rng?: () => number;
}

export function pickNode(
  deps: PickNodeDeps,
  model: string,
  tier: CustomerTier,
  capability: NodeCapability = 'chat',
): NodeEntry {
  const rng = deps.rng ?? Math.random;
  const candidates = deps.nodeBook.findNodesFor(model, tier, capability);
  const totalWeight = candidates.reduce((sum, c) => sum + c.config.weight, 0);
  if (totalWeight === 0) return candidates[0]!;

  let pick = rng() * totalWeight;
  for (const entry of candidates) {
    pick -= entry.config.weight;
    if (pick <= 0) return entry;
  }
  return candidates[0]!;
}
