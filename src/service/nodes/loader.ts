import type { Db } from '../../repo/db.js';
import * as nodeHealthRepo from '../../repo/nodeHealth.js';
import { detectEthAddressChanges, loadNodesConfig, type NodesConfig } from '../../config/nodes.js';
import { EthAddressChangedError } from './errors.js';
import type { NodeBook } from './nodebook.js';

export interface LoaderDeps {
  db: Db;
  nodeBook: NodeBook;
  configPath: string;
}

export interface NodesLoader {
  load(): NodesConfig;
  reload(): Promise<NodesConfig>;
  readonly current: NodesConfig | null;
}

export function createNodesLoader(deps: LoaderDeps): NodesLoader {
  let current: NodesConfig | null = null;

  function load(): NodesConfig {
    const cfg = loadNodesConfig(deps.configPath);
    const prevSnapshot = current
      ? deps.nodeBook.snapshot()
      : new Map<string, import('./nodebook.js').NodeEntry>();
    deps.nodeBook.replaceAll(cfg, prevSnapshot);
    current = cfg;
    return cfg;
  }

  async function reload(): Promise<NodesConfig> {
    const next = loadNodesConfig(deps.configPath);
    if (current) {
      const changes = detectEthAddressChanges(current, next);
      if (changes.length > 0) {
        for (const change of changes) {
          await nodeHealthRepo.insertNodeHealthEvent(deps.db, {
            nodeId: change.nodeId,
            kind: 'eth_address_changed_rejected',
            detail: `${change.oldAddress} → ${change.newAddress}`,
          });
        }
        throw new EthAddressChangedError(changes);
      }
    }
    const prevSnapshot = deps.nodeBook.snapshot();
    deps.nodeBook.replaceAll(next, prevSnapshot);
    current = next;
    for (const node of next.nodes) {
      await nodeHealthRepo.insertNodeHealthEvent(deps.db, {
        nodeId: node.id,
        kind: 'config_reloaded',
        detail: null,
      });
    }
    return next;
  }

  return {
    load,
    reload,
    get current() {
      return current;
    },
  };
}
