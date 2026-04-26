import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import type { CustomerTier } from '../../types/customer.js';
import type { NodeCapability } from '../../types/node.js';
import type {
  NodeRef,
  ServiceRegistryClient,
} from '../../providers/serviceRegistry.js';
import type { CircuitBreaker } from './circuitBreaker.js';
import { NoHealthyNodesError } from '../nodes/errors.js';

export interface PickNodeDeps {
  nodeBook: NodeBook;
  rng?: () => number;
}

/**
 * Legacy NodeBook-driven pick. Stays in place until task 18.7 swaps
 * dispatchers to `selectNode` (registry-driven). Keep behavior bit-exact
 * — existing tests assert on it.
 */
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

export interface SelectNodeDeps {
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  rng?: () => number;
  /** Caller-supplied "now" — defaults to a fresh Date. */
  now?: () => Date;
}

export interface SelectNodeQuery {
  model: string;
  tier: CustomerTier;
  capability: NodeCapability;
}

/**
 * Registry-driven node selection with bridge-local circuit-breaker
 * exclusion (option a2 from exec-plan 0025).
 *
 * Daemon does most of the work via `Select(capability, model, tier)`;
 * the bridge filters out currently-circuit-broken nodes locally and
 * picks one weighted-randomly from the remainder. The exclusion set
 * is computed AFTER the daemon RPC (rather than passed into Select)
 * because the v1 service-registry proto doesn't accept an exclude_ids
 * param. Future daemon revisions can move this filter daemon-side.
 *
 * Throws `NoHealthyNodesError` when the daemon returns nothing OR
 * everything it returned is circuit-broken locally.
 */
export async function selectNode(
  deps: SelectNodeDeps,
  query: SelectNodeQuery,
): Promise<NodeRef> {
  const rng = deps.rng ?? Math.random;
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await deps.serviceRegistry.select({
    capability: query.capability,
    model: query.model,
    tier: query.tier,
  });
  const exclusions = new Set(deps.circuitBreaker.currentExclusions(now));
  const eligible = candidates.filter((c) => !exclusions.has(c.id));
  if (eligible.length === 0) {
    throw new NoHealthyNodesError(query.model, query.tier);
  }
  const totalWeight = eligible.reduce((sum, c) => sum + (c.weight ?? 1), 0);
  if (totalWeight === 0) return eligible[0]!;
  let pick = rng() * totalWeight;
  for (const ref of eligible) {
    pick -= ref.weight ?? 1;
    if (pick <= 0) return ref;
  }
  return eligible[0]!;
}
