import type { PayerDaemonClient } from '../../providers/payerDaemon.js';
import type { Quote, TicketParams } from '../../types/node.js';

export interface SessionKey {
  nodeId: string;
  recipient: string;
  expirationBlock: bigint;
}

interface SessionEntry {
  key: SessionKey;
  workId: string;
  ticketParams: TicketParams;
  expiresAt: Date;
}

function keyToString(k: SessionKey): string {
  return `${k.nodeId}|${k.recipient.toLowerCase()}|${k.expirationBlock.toString()}`;
}

export interface SessionCacheDeps {
  payerDaemon: PayerDaemonClient;
  now?: () => Date;
}

export interface SessionCache {
  getOrStart(nodeId: string, quote: Quote, signal?: AbortSignal): Promise<string>;
  close(nodeId: string): Promise<void>;
  closeAll(signal?: AbortSignal): Promise<void>;
  readonly size: number;
}

export function createSessionCache(deps: SessionCacheDeps): SessionCache {
  const entries = new Map<string, SessionEntry>();
  const now = deps.now ?? (() => new Date());

  return {
    async getOrStart(nodeId, quote, signal) {
      const key: SessionKey = {
        nodeId,
        recipient: quote.ticketParams.recipient,
        expirationBlock: quote.ticketParams.expirationBlock,
      };
      const id = keyToString(key);
      const existing = entries.get(id);
      if (existing && existing.expiresAt > now()) {
        return existing.workId;
      }
      if (existing) entries.delete(id);

      const { workId } = await deps.payerDaemon.startSession(
        { ticketParams: quote.ticketParams, label: nodeId },
        signal,
      );
      entries.set(id, {
        key,
        workId,
        ticketParams: quote.ticketParams,
        expiresAt: quote.expiresAt,
      });
      return workId;
    },

    async close(nodeId) {
      const toClose: SessionEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.key.nodeId === nodeId) toClose.push(entry);
      }
      for (const entry of toClose) {
        entries.delete(keyToString(entry.key));
        await deps.payerDaemon.closeSession(entry.workId).catch(() => undefined);
      }
    },

    async closeAll(signal) {
      const all = Array.from(entries.values());
      entries.clear();
      for (const entry of all) {
        await deps.payerDaemon.closeSession(entry.workId, signal).catch(() => undefined);
      }
    },

    get size() {
      return entries.size;
    },
  };
}
