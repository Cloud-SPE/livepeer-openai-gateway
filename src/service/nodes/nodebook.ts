import type { ResolvedNodeConfig, NodesConfig } from '../../config/nodes.js';
import type { NodeCapability, Quote } from '../../types/node.js';
import { capabilityString } from '../../types/capability.js';
import { CircuitState, initialCircuitState } from '../routing/circuitBreaker.js';
import { NoHealthyNodesError } from './errors.js';

/**
 * NodeEntry carries one Quote per advertised capability, keyed by
 * the canonical capability string (e.g. "openai:/v1/chat/completions").
 * Pre-0020 the entry held a single Quote regardless of capability;
 * with multi-capability workers that meant non-chat requests rode
 * on the chat quote (wrong recipient_rand_hash, wrong face_value
 * sizing).
 *
 * A node advertised in nodes.yaml but missing a quote for a given
 * capability is treated like circuit_broken for that capability —
 * findNodesFor excludes it from the candidate list.
 */
export interface NodeEntry {
  config: ResolvedNodeConfig;
  circuit: CircuitState;
  quotes: Map<string, Quote>;
}

export class NodeBook {
  private readonly entries = new Map<string, NodeEntry>();
  // Reverse index for url → id, rebuilt every replaceAll. Used by the
  // `nodeClient` metrics decorator to label outbound requests by node_id
  // (the underlying client only knows the URL).
  private readonly urlToId = new Map<string, string>();

  replaceAll(config: NodesConfig, previous?: Map<string, NodeEntry>): void {
    this.entries.clear();
    this.urlToId.clear();
    for (const node of config.nodes) {
      const prev = previous?.get(node.id);
      this.entries.set(node.id, {
        config: node,
        circuit: prev?.circuit ?? initialCircuitState(),
        quotes: prev?.quotes ?? new Map(),
      });
      this.urlToId.set(node.url, node.id);
    }
  }

  /**
   * Reverse lookup from worker base URL to node id. Returns undefined when
   * the URL is not advertised in the current nodes.yaml. Match is exact —
   * the caller passes whatever URL the NodeClient knows about.
   */
  findIdByUrl(url: string): string | undefined {
    return this.urlToId.get(url);
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

  /**
   * Set the quote for a specific (node, capability) pair. The
   * capability key is the canonical worker-emitted string (use
   * `capabilityString('chat')` etc., NOT the short-form enum).
   */
  setCapabilityQuote(nodeId: string, capability: string, quote: Quote): void {
    const entry = this.entries.get(nodeId);
    if (!entry) return;
    const quotes = new Map(entry.quotes);
    quotes.set(capability, quote);
    this.entries.set(nodeId, { ...entry, quotes });
  }

  /**
   * Replace all quotes for a node atomically. Used by the refresher
   * after a successful /quotes batch.
   */
  setAllQuotes(nodeId: string, quotes: Map<string, Quote>): void {
    const entry = this.entries.get(nodeId);
    if (!entry) return;
    this.entries.set(nodeId, { ...entry, quotes: new Map(quotes) });
  }

  findNodesFor(
    model: string,
    tier: 'free' | 'prepaid',
    capability: NodeCapability = 'chat',
  ): NodeEntry[] {
    const cap = capabilityString(capability);
    const candidates = this.list().filter(
      (e) =>
        e.config.enabled &&
        e.config.capabilities.includes(capability) &&
        e.config.supportedModels.includes(model) &&
        e.config.tierAllowed.includes(tier) &&
        e.circuit.status !== 'circuit_broken' &&
        e.quotes.has(cap),
    );
    if (candidates.length === 0) throw new NoHealthyNodesError(model, tier);
    return candidates.sort((a, b) => b.config.weight - a.config.weight);
  }
}
