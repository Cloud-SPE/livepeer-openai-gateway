import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { NodeConfigSchema, type NodeConfig } from '../types/node.js';

export const NodeRefreshConfigSchema = z
  .object({
    quoteRefreshSeconds: z.number().int().positive().default(30),
    healthTimeoutMs: z.number().int().positive().default(5_000),
    quoteTimeoutMs: z.number().int().positive().default(10_000),
  })
  .default({});
export type NodeRefreshConfig = z.infer<typeof NodeRefreshConfigSchema>;

export const CircuitBreakerConfigSchema = z
  .object({
    failureThreshold: z.number().int().positive().default(5),
    coolDownSeconds: z.number().int().positive().default(30),
  })
  .default({});
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

const YamlNodeSchema = NodeConfigSchema.extend({
  quoteRefreshSeconds: z.number().int().positive().optional(),
  healthTimeoutMs: z.number().int().positive().optional(),
  quoteTimeoutMs: z.number().int().positive().optional(),
  failureThreshold: z.number().int().positive().optional(),
  coolDownSeconds: z.number().int().positive().optional(),
});
type YamlNode = z.infer<typeof YamlNodeSchema>;

const NodesYamlSchema = z.object({
  nodes: z.array(YamlNodeSchema).min(1),
});

export interface ResolvedNodeConfig extends NodeConfig {
  refresh: NodeRefreshConfig;
  breaker: CircuitBreakerConfig;
}

export interface NodesConfig {
  nodes: ResolvedNodeConfig[];
}

export function parseNodesYaml(raw: string): NodesConfig {
  const doc = yaml.load(raw);
  const parsed = NodesYamlSchema.parse(doc);
  return {
    nodes: parsed.nodes.map(resolveNode),
  };
}

export function loadNodesConfig(path: string): NodesConfig {
  const raw = readFileSync(path, 'utf8');
  return parseNodesYaml(raw);
}

function resolveNode(node: YamlNode): ResolvedNodeConfig {
  const {
    quoteRefreshSeconds,
    healthTimeoutMs,
    quoteTimeoutMs,
    failureThreshold,
    coolDownSeconds,
    ...base
  } = node;
  const refresh = NodeRefreshConfigSchema.parse({
    ...(quoteRefreshSeconds !== undefined ? { quoteRefreshSeconds } : {}),
    ...(healthTimeoutMs !== undefined ? { healthTimeoutMs } : {}),
    ...(quoteTimeoutMs !== undefined ? { quoteTimeoutMs } : {}),
  });
  const breaker = CircuitBreakerConfigSchema.parse({
    ...(failureThreshold !== undefined ? { failureThreshold } : {}),
    ...(coolDownSeconds !== undefined ? { coolDownSeconds } : {}),
  });
  return { ...base, refresh, breaker };
}

export interface EthAddressChange {
  nodeId: string;
  oldAddress: string;
  newAddress: string;
}

export function detectEthAddressChanges(prev: NodesConfig, next: NodesConfig): EthAddressChange[] {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n.ethAddress]));
  const changes: EthAddressChange[] = [];
  for (const node of next.nodes) {
    const old = prevById.get(node.id);
    if (old !== undefined && old.toLowerCase() !== node.ethAddress.toLowerCase()) {
      changes.push({ nodeId: node.id, oldAddress: old, newAddress: node.ethAddress });
    }
  }
  return changes;
}
