import type { Db } from '../../repo/db.js';
import * as nodeHealthRepo from '../../repo/nodeHealth.js';
import type { NodeClient } from '../../providers/nodeClient.js';
import { onFailure, onSuccess, shouldProbe, type CircuitResult } from './circuitBreaker.js';
import type { NodeBook } from './nodebook.js';
import type { Scheduler, ScheduledTask } from './scheduler.js';

export interface QuoteRefresherDeps {
  db: Db;
  nodeBook: NodeBook;
  nodeClient: NodeClient;
  scheduler: Scheduler;
  // bridgeEthAddress (0x-prefixed 40-hex) is threaded through as the
  // `?sender=` query param on /quote and /quotes against the worker.
  // Introduced in 0018-worker-wire-format-alignment.
  bridgeEthAddress: string;
}

export interface QuoteRefresher {
  start(): void;
  stop(): void;
  tickNode(nodeId: string): Promise<void>;
}

export function createQuoteRefresher(deps: QuoteRefresherDeps): QuoteRefresher {
  const tasks = new Map<string, ScheduledTask>();
  let running = false;

  function scheduleNode(nodeId: string, delayMs: number): void {
    const task = deps.scheduler.schedule(async () => {
      if (!running) return;
      await tickNode(nodeId);
      const entry = deps.nodeBook.get(nodeId);
      if (entry && running) {
        scheduleNode(nodeId, entry.config.refresh.quoteRefreshSeconds * 1000);
      }
    }, delayMs);
    tasks.set(nodeId, task);
  }

  async function tickNode(nodeId: string): Promise<void> {
    const entry = deps.nodeBook.get(nodeId);
    if (!entry || !entry.config.enabled) return;

    const now = deps.scheduler.now();
    const probeDecision = shouldProbe(entry.circuit, entry.config.breaker, now);
    if (!probeDecision.probe) {
      return;
    }

    if (probeDecision.result.transition.kind === 'circuit_half_opened') {
      deps.nodeBook.setCircuit(nodeId, probeDecision.result.state);
      await persist(deps.db, nodeId, probeDecision.result);
    }

    try {
      const health = await deps.nodeClient.getHealth(
        entry.config.url,
        entry.config.refresh.healthTimeoutMs,
      );
      if (health.status !== 'ok' && health.status !== 'degraded') {
        throw new Error(`unexpected health status: ${String(health.status)}`);
      }
      // Phase 1 (0018): one quote per node, keyed on the single
      // chat-completions capability. Phase 2 will probe /capabilities +
      // /quotes to populate per-(capability, model) quotes on the
      // NodeBook. Until then, every node is treated as a chat node for
      // quote-refresh purposes.
      const quote = await deps.nodeClient.getQuote({
        url: entry.config.url,
        sender: deps.bridgeEthAddress,
        capability: 'openai:/v1/chat/completions',
        timeoutMs: entry.config.refresh.quoteTimeoutMs,
      });
      const result = onSuccess(
        deps.nodeBook.get(nodeId)?.circuit ?? probeDecision.result.state,
        entry.config.breaker,
        deps.scheduler.now(),
      );
      deps.nodeBook.setCircuit(nodeId, result.state);
      deps.nodeBook.setQuote(nodeId, quote);
      await persist(deps.db, nodeId, result);
    } catch (err) {
      const result = onFailure(
        deps.nodeBook.get(nodeId)?.circuit ?? probeDecision.result.state,
        entry.config.breaker,
        deps.scheduler.now(),
      );
      deps.nodeBook.setCircuit(nodeId, result.state);
      await persist(deps.db, nodeId, result, err instanceof Error ? err.message : String(err));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (const entry of deps.nodeBook.list()) {
        scheduleNode(entry.config.id, 0);
      }
    },
    stop() {
      running = false;
      for (const task of tasks.values()) task.cancel();
      tasks.clear();
    },
    async tickNode(nodeId) {
      await tickNode(nodeId);
    },
  };
}

async function persist(
  db: Db,
  nodeId: string,
  result: CircuitResult,
  failureDetail?: string,
): Promise<void> {
  await nodeHealthRepo.upsertNodeHealth(db, {
    nodeId,
    status: result.state.status,
    consecutiveFailures: result.state.consecutiveFailures,
    lastSuccessAt: result.state.lastSuccessAt,
    lastFailureAt: result.state.lastFailureAt,
    circuitOpenedAt: result.state.circuitOpenedAt,
    updatedAt: new Date(),
  });
  if (result.transition.kind !== 'none') {
    await nodeHealthRepo.insertNodeHealthEvent(db, {
      nodeId,
      kind: result.transition.kind,
      detail: failureDetail ?? null,
    });
  }
}
