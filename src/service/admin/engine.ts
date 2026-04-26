import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import type { PayerDaemonClient } from '../../providers/payerDaemon.js';
import type { RedisClient } from '../../providers/redis.js';
import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import { nodeHealthEvents } from '../../repo/schema.js';

/**
 * Engine half of the admin service. Owns node and payment-daemon
 * operations: health, node listing, node detail, escrow info. Stage 3
 * will extract this into the OSS engine package alongside its shell
 * counterpart.
 *
 * Stage-2 note: still backed by NodeBook for listNodes/getNode (since
 * NodeBook still owns per-node CircuitState here). Retiring NodeBook
 * for the admin path requires also wiring CircuitBreaker into the
 * admin layer — deferred to a follow-up that retires NodeBook entirely.
 *
 * Per exec-plan 0025.
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
  status: 'healthy' | 'degraded' | 'circuit_broken';
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
  nodeBook: NodeBook;
}

export interface EngineAdminService {
  getHealth(): Promise<HealthReport>;
  listNodes(): NodeSummary[];
  getNode(id: string): Promise<NodeDetail | null>;
  getEscrow(): Promise<EscrowReport>;
}

export function createEngineAdminService(deps: EngineAdminServiceDeps): EngineAdminService {
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
      const nodes = deps.nodeBook.list();
      const healthy = nodes.filter((n) => n.circuit.status === 'healthy').length;
      return {
        ok: dbOk && redisOk && deps.payerDaemon.isHealthy(),
        payerDaemonHealthy: deps.payerDaemon.isHealthy(),
        dbOk,
        redisOk,
        nodeCount: nodes.length,
        nodesHealthy: healthy,
      };
    },

    listNodes(): NodeSummary[] {
      return deps.nodeBook.list().map(toSummary);
    },

    async getNode(id: string): Promise<NodeDetail | null> {
      const entry = deps.nodeBook.get(id);
      if (!entry) return null;
      const events = await deps.db
        .select()
        .from(nodeHealthEvents)
        .where(eq(nodeHealthEvents.nodeId, id))
        .orderBy(desc(nodeHealthEvents.occurredAt))
        .limit(20);
      return {
        ...toSummary(entry),
        circuit: {
          consecutiveFailures: entry.circuit.consecutiveFailures,
          lastSuccessAt: entry.circuit.lastSuccessAt,
          lastFailureAt: entry.circuit.lastFailureAt,
          circuitOpenedAt: entry.circuit.circuitOpenedAt,
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

function toSummary(entry: NodeEntry): NodeSummary {
  return {
    id: entry.config.id,
    url: entry.config.url,
    enabled: entry.config.enabled,
    status: entry.circuit.status,
    tierAllowed: entry.config.tierAllowed,
    supportedModels: entry.config.supportedModels,
    weight: entry.config.weight,
  };
}
