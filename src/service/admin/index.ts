import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../repo/db.js';
import type { PayerDaemonClient } from '../../providers/payerDaemon.js';
import type { RedisClient } from '../../providers/redis.js';
import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import * as customersRepo from '../../repo/customers.js';
import * as topupsRepo from '../../repo/topups.js';
import { topups, usageRecords, nodeHealthEvents } from '../../repo/schema.js';
import { reverseTopup, setCustomerStatus } from '../billing/topups.js';
import type { ReverseTopupResult } from '../billing/topups.js';

export interface HealthReport {
  ok: boolean;
  payerDaemonHealthy: boolean;
  dbOk: boolean;
  redisOk: boolean;
  nodeCount: number;
  nodesHealthy: number;
}

export interface AdminServiceDeps {
  db: Db;
  payerDaemon: PayerDaemonClient;
  redis?: RedisClient;
  nodeBook: NodeBook;
}

export interface AdminService {
  getHealth(): Promise<HealthReport>;
  listNodes(): NodeSummary[];
  getNode(id: string): Promise<NodeDetail | null>;
  getCustomer(id: string): Promise<CustomerDetail | null>;
  reverseCustomerTopup(input: {
    stripeSessionId: string;
    reason: string;
  }): Promise<ReverseTopupResult>;
  suspendCustomer(id: string): Promise<boolean>;
  unsuspendCustomer(id: string): Promise<boolean>;
  getEscrow(): Promise<EscrowReport>;
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

export interface CustomerDetail {
  id: string;
  email: string;
  tier: 'free' | 'prepaid';
  status: 'active' | 'suspended' | 'closed';
  balanceUsdCents: string;
  reservedUsdCents: string;
  quotaTokensRemaining: string | null;
  quotaMonthlyAllowance: string | null;
  rateLimitTier: string;
  createdAt: Date;
  topups: Array<{
    stripeSessionId: string;
    amountUsdCents: string;
    status: string;
    createdAt: Date;
    refundedAt: Date | null;
    disputedAt: Date | null;
  }>;
  recentUsage: Array<{
    workId: string;
    model: string;
    costUsdCents: string;
    status: string;
    createdAt: Date;
  }>;
}

export interface EscrowReport {
  depositWei: string;
  reserveWei: string;
  withdrawRound: string;
  source: 'payer_daemon';
}

export function createAdminService(deps: AdminServiceDeps): AdminService {
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

    async getCustomer(id: string): Promise<CustomerDetail | null> {
      const customer = await customersRepo.findById(deps.db, id);
      if (!customer) return null;

      const customerTopups = await deps.db
        .select()
        .from(topups)
        .where(eq(topups.customerId, id))
        .orderBy(desc(topups.createdAt))
        .limit(20);

      const usage = await deps.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.customerId, id))
        .orderBy(desc(usageRecords.createdAt))
        .limit(50);

      return {
        id: customer.id,
        email: customer.email,
        tier: customer.tier,
        status: customer.status,
        balanceUsdCents: customer.balanceUsdCents.toString(),
        reservedUsdCents: customer.reservedUsdCents.toString(),
        quotaTokensRemaining: customer.quotaTokensRemaining?.toString() ?? null,
        quotaMonthlyAllowance: customer.quotaMonthlyAllowance?.toString() ?? null,
        rateLimitTier: customer.rateLimitTier,
        createdAt: customer.createdAt,
        topups: customerTopups.map((t) => ({
          stripeSessionId: t.stripeSessionId,
          amountUsdCents: t.amountUsdCents.toString(),
          status: t.status,
          createdAt: t.createdAt,
          refundedAt: t.refundedAt,
          disputedAt: t.disputedAt,
        })),
        recentUsage: usage.map((u) => ({
          workId: u.workId,
          model: u.model,
          costUsdCents: u.costUsdCents.toString(),
          status: u.status,
          createdAt: u.createdAt,
        })),
      };
    },

    async reverseCustomerTopup(input): Promise<ReverseTopupResult> {
      return reverseTopup(deps.db, input);
    },

    async suspendCustomer(id) {
      return setCustomerStatus(deps.db, id, 'suspended');
    },

    async unsuspendCustomer(id) {
      return setCustomerStatus(deps.db, id, 'active');
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

  // Silence unused
  void topupsRepo;
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
