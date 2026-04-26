import type { Db } from '../../repo/db.js';
import * as nodeHealthRepo from '../../repo/nodeHealth.js';
import type { NodeClient } from '../../providers/nodeClient.js';
import { wireQuoteToDomain } from '../../providers/nodeClient/wireQuote.js';
import type { ServiceRegistryClient } from '../../providers/serviceRegistry.js';
import { CAPABILITY_STRINGS as CAPABILITY_TO_CANONICAL } from '../../types/capability.js';
import type { Quote } from '../../types/node.js';
import {
  NODE_STATE_CIRCUIT_BROKEN,
  NODE_STATE_DEGRADED,
  NODE_STATE_HEALTHY,
  type NodeState,
  type Recorder,
} from '../../providers/metrics/recorder.js';
import { CircuitBreaker, type CircuitStatus, type CircuitTransition } from './circuitBreaker.js';
import type { QuoteCache } from './quoteCache.js';
import type { Scheduler, ScheduledTask } from './scheduler.js';
import type { RoutingConfig } from '../../config/routing.js';

function statusToMetricState(status: CircuitStatus): NodeState {
  switch (status) {
    case 'healthy':
      return NODE_STATE_HEALTHY;
    case 'degraded':
      return NODE_STATE_DEGRADED;
    case 'circuit_broken':
      return NODE_STATE_CIRCUIT_BROKEN;
  }
}

export interface QuoteRefresherDeps {
  db: Db;
  serviceRegistry: ServiceRegistryClient;
  nodeClient: NodeClient;
  circuitBreaker: CircuitBreaker;
  quoteCache: QuoteCache;
  scheduler: Scheduler;
  config: RoutingConfig;
  bridgeEthAddress: string;
  recorder?: Recorder;
}

export interface QuoteRefresher {
  /** Enumerate the registry and schedule per-node ticks. */
  start(): Promise<void>;
  stop(): void;
  /** Refresh exactly one node's quotes — used for tests + admin "refresh now". */
  tickNode(nodeId: string, url: string, advertisedCapabilities: readonly string[]): Promise<void>;
}

/**
 * service-registry-driven quote-refresh loop. Replaces the legacy
 * NodeBook-driven refresher in src/service/nodes/quoteRefresher.ts.
 *
 * Lifecycle:
 *   start() → enumerate `serviceRegistry.listKnown()` once, schedule a
 *     per-node tick at `config.quoteRefreshSeconds` interval. New nodes
 *     surface at the next start() or via an explicit re-enumeration
 *     (caller-driven; the daemon's audit log tells the bridge when
 *     membership changes — out of scope for v1).
 *   tickNode(nodeId, url, capabilities):
 *     - shouldProbe(nodeId) → if not, return.
 *     - GET /health, GET /quotes
 *     - on success: circuitBreaker.onSuccess; quoteCache.replaceNode
 *     - on failure: circuitBreaker.onFailure; persist node_health rows
 *     - emit transition + quote-age metrics
 *
 * Per exec-plan 0025.
 */
export function createQuoteRefresher(deps: QuoteRefresherDeps): QuoteRefresher {
  const tasks = new Map<string, ScheduledTask>();
  let running = false;

  function scheduleNode(
    nodeId: string,
    url: string,
    advertisedCapabilities: readonly string[],
    delayMs: number,
  ): void {
    const task = deps.scheduler.schedule(async () => {
      if (!running) return;
      await tickNode(nodeId, url, advertisedCapabilities);
      if (running) {
        scheduleNode(nodeId, url, advertisedCapabilities, deps.config.quoteRefreshSeconds * 1000);
      }
    }, delayMs);
    tasks.set(nodeId, task);
  }

  async function tickNode(
    nodeId: string,
    url: string,
    advertisedCapabilities: readonly string[],
  ): Promise<void> {
    const now = deps.scheduler.now();
    const probeDecision = deps.circuitBreaker.shouldProbe(nodeId, now);
    if (!probeDecision.probe) return;

    if (probeDecision.transition.kind === 'circuit_half_opened') {
      await persist(deps.db, nodeId, deps.circuitBreaker.state(nodeId), probeDecision.transition);
      deps.recorder?.incNodeCircuitTransition(
        nodeId,
        statusToMetricState(deps.circuitBreaker.state(nodeId).status),
      );
    }

    try {
      const health = await deps.nodeClient.getHealth(url, deps.config.healthTimeoutMs);
      if (health.status !== 'ok' && health.status !== 'degraded') {
        throw new Error(`unexpected health status: ${String(health.status)}`);
      }
      const batched = await deps.nodeClient.getQuotes({
        url,
        sender: deps.bridgeEthAddress,
        timeoutMs: deps.config.quoteTimeoutMs,
      });
      const advertisedSet = new Set(advertisedCapabilities);
      const newQuotes = new Map<string, Quote>();
      for (const { capability, quote } of batched.quotes) {
        if (!advertisedSet.has(capability)) continue;
        newQuotes.set(capability, wireQuoteToDomain(quote));
      }
      const transition = deps.circuitBreaker.onSuccess(nodeId, deps.scheduler.now());
      deps.quoteCache.replaceNode(nodeId, newQuotes);
      await persist(deps.db, nodeId, deps.circuitBreaker.state(nodeId), transition);
      if (deps.recorder) {
        if (transition.kind !== 'none') {
          deps.recorder.incNodeCircuitTransition(
            nodeId,
            statusToMetricState(deps.circuitBreaker.state(nodeId).status),
          );
        }
        for (const cap of newQuotes.keys()) {
          deps.recorder.setNodeQuoteAgeSeconds(nodeId, cap, 0);
        }
      }
    } catch (err) {
      const transition = deps.circuitBreaker.onFailure(nodeId, deps.scheduler.now());
      await persist(
        deps.db,
        nodeId,
        deps.circuitBreaker.state(nodeId),
        transition,
        err instanceof Error ? err.message : String(err),
      );
      if (deps.recorder && transition.kind !== 'none') {
        deps.recorder.incNodeCircuitTransition(
          nodeId,
          statusToMetricState(deps.circuitBreaker.state(nodeId).status),
        );
      }
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      try {
        const nodes = await deps.serviceRegistry.listKnown();
        for (const ref of nodes) {
          const advertised = ref.capabilities.map((c) => CAPABILITY_TO_CANONICAL[c]);
          scheduleNode(ref.id, ref.url, advertised, 0);
        }
      } catch {
        // Initial enumeration failure is non-fatal — caller's restart
        // will retry. The dispatchers fail fast on no-quote state.
      }
    },
    stop() {
      running = false;
      for (const task of tasks.values()) task.cancel();
      tasks.clear();
    },
    async tickNode(nodeId, url, advertisedCapabilities) {
      await tickNode(nodeId, url, advertisedCapabilities);
    },
  };
}

async function persist(
  db: Db,
  nodeId: string,
  state: { status: CircuitStatus; consecutiveFailures: number; lastSuccessAt: Date | null; lastFailureAt: Date | null; circuitOpenedAt: Date | null },
  transition: CircuitTransition,
  failureDetail?: string,
): Promise<void> {
  await nodeHealthRepo.upsertNodeHealth(db, {
    nodeId,
    status: state.status,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    circuitOpenedAt: state.circuitOpenedAt,
    updatedAt: new Date(),
  });
  if (transition.kind !== 'none') {
    await nodeHealthRepo.insertNodeHealthEvent(db, {
      nodeId,
      kind: transition.kind,
      detail: failureDetail ?? null,
    });
  }
}

