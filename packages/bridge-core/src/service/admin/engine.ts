import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import type { PayerDaemonClient } from '../../providers/payerDaemon.js';
import type { RedisClient } from '../../providers/redis.js';
import type { CircuitBreaker, CircuitStatus } from '../routing/circuitBreaker.js';
import type { NodeIndex } from '../routing/nodeIndex.js';
import type { NodeRef } from '../../providers/serviceRegistry.js';
import { nodeHealthEvents } from '../../repo/schema.js';

/**
 * Engine half of the admin service. Owns node and payment-daemon
 * operations: health, node listing, node detail, escrow info. Stage 3
 * extracts this into the OSS engine package alongside its shell
 * counterpart.
 *
 * Sources of truth (post stage-2 carry-over):
 *   - identity (id, url, capabilities, weight): registry-daemon snapshot
 *     surfaced via NodeIndex
 *   - circuit state (status, consecutiveFailures, lastSuccessAt, ...):
 *     CircuitBreaker keyed by node id
 *   - history: nodeHealthEvents table
 *
 * Per exec-plan 0026.
 */
export interface HealthReport {
  ok: boolean;
  payerDaemonHealthy: boolean;
  dbOk: boolean;
  redisOk: boolean;
  nodeCount: number;
  nodesHealthy: number;
}

export interface NodeSummary {
  id: string;
  url: string;
  enabled: boolean;
  status: CircuitStatus;
  tierAllowed: readonly ('free' | 'prepaid')[];
  supportedModels: readonly string[];
  weight: number;
}

export interface NodeDetail extends NodeSummary {
  circuit: {
    consecutiveFailures: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    circuitOpenedAt: Date | null;
  };
  recentEvents: Array<{
    kind: string;
    detail: string | null;
    occurredAt: Date;
  }>;
}

export interface EscrowReport {
  depositWei: string;
  reserveWei: string;
  withdrawRound: string;
  source: 'payer_daemon';
}

export interface EngineAdminServiceDeps {
  db: Db;
  payerDaemon: PayerDaemonClient;
  redis?: RedisClient;
  nodeIndex: NodeIndex;
  circuitBreaker: CircuitBreaker;
}

export interface EngineAdminService {
  getHealth(): Promise<HealthReport>;
  listNodes(): NodeSummary[];
  getNode(id: string): Promise<NodeDetail | null>;
  getEscrow(): Promise<EscrowReport>;
}

export function createEngineAdminService(deps: EngineAdminServiceDeps): EngineAdminService {
  function summarize(ref: NodeRef): NodeSummary {
    return {
      id: ref.id,
      url: ref.url,
      enabled: true,
      status: deps.circuitBreaker.state(ref.id).status,
      tierAllowed: [],
      supportedModels: [],
      weight: ref.weight ?? 0,
    };
  }

  return {
    async getHealth(): Promise<HealthReport> {
      let dbOk = true;
      try {
        await deps.db.execute(sql`SELECT 1`);
      } catch {
        dbOk = false;
      }
      let redisOk = true;
      if (deps.redis) {
        try {
          const pong = await deps.redis.ping();
          redisOk = pong === 'PONG';
        } catch {
          redisOk = false;
        }
      }
      const refs = deps.nodeIndex.list();
      const healthy = refs.filter(
        (r) => deps.circuitBreaker.state(r.id).status === 'healthy',
      ).length;
      return {
        ok: dbOk && redisOk && deps.payerDaemon.isHealthy(),
        payerDaemonHealthy: deps.payerDaemon.isHealthy(),
        dbOk,
        redisOk,
        nodeCount: refs.length,
        nodesHealthy: healthy,
      };
    },

    listNodes(): NodeSummary[] {
      return deps.nodeIndex.list().map(summarize);
    },

    async getNode(id: string): Promise<NodeDetail | null> {
      const ref = deps.nodeIndex.get(id);
      if (!ref) return null;
      const state = deps.circuitBreaker.state(id);
      const events = await deps.db
        .select()
        .from(nodeHealthEvents)
        .where(eq(nodeHealthEvents.nodeId, id))
        .orderBy(desc(nodeHealthEvents.occurredAt))
        .limit(20);
      return {
        ...summarize(ref),
        circuit: {
          consecutiveFailures: state.consecutiveFailures,
          lastSuccessAt: state.lastSuccessAt,
          lastFailureAt: state.lastFailureAt,
          circuitOpenedAt: state.circuitOpenedAt,
        },
        recentEvents: events.map((e) => ({
          kind: e.kind,
          detail: e.detail,
          occurredAt: e.occurredAt,
        })),
      };
    },

    async getEscrow(): Promise<EscrowReport> {
      const info = await deps.payerDaemon.getDepositInfo();
      return {
        depositWei: info.depositWei.toString(),
        reserveWei: info.reserveWei.toString(),
        withdrawRound: info.withdrawRound.toString(),
        source: 'payer_daemon',
      };
    },
  };
}
