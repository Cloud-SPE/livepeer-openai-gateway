import type { ResolvedNodeConfig, NodesConfig } from '../../config/nodes.js';
import type { NodeCapability, Quote } from '../../types/node.js';
import { CircuitState, initialCircuitState } from './circuitBreaker.js';
import { NoHealthyNodesError } from './errors.js';

export interface NodeEntry {
  config: ResolvedNodeConfig;
  circuit: CircuitState;
  quote: Quote | null;
}

export class NodeBook {
  private readonly entries = new Map<string, NodeEntry>();

  replaceAll(config: NodesConfig, previous?: Map<string, NodeEntry>): void {
    this.entries.clear();
    for (const node of config.nodes) {
      const prev = previous?.get(node.id);
      this.entries.set(node.id, {
        config: node,
        circuit: prev?.circuit ?? initialCircuitState(),
        quote: prev?.quote ?? null,
      });
    }
  }

  snapshot(): Map<string, NodeEntry> {
    return new Map(this.entries);
  }

  get(nodeId: string): NodeEntry | undefined {
    return this.entries.get(nodeId);
  }

  list(): NodeEntry[] {
    return Array.from(this.entries.values());
  }

  setCircuit(nodeId: string, circuit: CircuitState): void {
    const entry = this.entries.get(nodeId);
    if (!entry) return;
    this.entries.set(nodeId, { ...entry, circuit });
  }

  setQuote(nodeId: string, quote: Quote): void {
    const entry = this.entries.get(nodeId);
    if (!entry) return;
    this.entries.set(nodeId, { ...entry, quote });
  }

  findNodesFor(
    model: string,
    tier: 'free' | 'prepaid',
    capability: NodeCapability = 'chat',
  ): NodeEntry[] {
    const candidates = this.list().filter(
      (e) =>
        e.config.enabled &&
        e.config.capabilities.includes(capability) &&
        e.config.supportedModels.includes(model) &&
        e.config.tierAllowed.includes(tier) &&
        e.circuit.status !== 'circuit_broken',
    );
    if (candidates.length === 0) throw new NoHealthyNodesError(model, tier);
    return candidates.sort((a, b) => b.config.weight - a.config.weight);
  }
}
