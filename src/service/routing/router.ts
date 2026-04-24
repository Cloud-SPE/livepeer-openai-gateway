import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import type { CustomerTier } from '../../types/customer.js';

export interface PickNodeDeps {
  nodeBook: NodeBook;
  rng?: () => number;
}

export function pickNode(deps: PickNodeDeps, model: string, tier: CustomerTier): NodeEntry {
  const rng = deps.rng ?? Math.random;
  const candidates = deps.nodeBook.findNodesFor(model, tier);
  const totalWeight = candidates.reduce((sum, c) => sum + c.config.weight, 0);
  if (totalWeight === 0) return candidates[0]!;

  let pick = rng() * totalWeight;
  for (const entry of candidates) {
    pick -= entry.config.weight;
    if (pick <= 0) return entry;
  }
  // Fallback: rng() returned ≥ 1 or float drift — return highest-weight node.
  return candidates[0]!;
}
