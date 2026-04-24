import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const customerTier = pgEnum('customer_tier', ['free', 'prepaid']);
export const customerStatus = pgEnum('customer_status', ['active', 'suspended', 'closed']);
export const usageStatus = pgEnum('usage_status', ['success', 'partial', 'failed']);
export const topupStatus = pgEnum('topup_status', ['pending', 'succeeded', 'failed', 'refunded']);
export const reservationState = pgEnum('reservation_state', ['open', 'committed', 'refunded']);
export const reservationKind = pgEnum('reservation_kind', ['prepaid', 'free']);
export const nodeHealthStatus = pgEnum('node_health_status', [
  'healthy',
  'degraded',
  'circuit_broken',
]);
export const nodeHealthEventKind = pgEnum('node_health_event_kind', [
  'circuit_opened',
  'circuit_half_opened',
  'circuit_closed',
  'config_reloaded',
  'eth_address_changed_rejected',
]);

export const customers = pgTable('customer', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  tier: customerTier('tier').notNull(),
  status: customerStatus('status').notNull().default('active'),
  rateLimitTier: text('rate_limit_tier').notNull().default('default'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  balanceUsdCents: bigint('balance_usd_cents', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  reservedUsdCents: bigint('reserved_usd_cents', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  quotaTokensRemaining: bigint('quota_tokens_remaining', { mode: 'bigint' }),
  quotaMonthlyAllowance: bigint('quota_monthly_allowance', { mode: 'bigint' }),
  quotaReservedTokens: bigint('quota_reserved_tokens', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  quotaResetAt: timestamp('quota_reset_at', { withTimezone: true }),
});

export const apiKeys = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    hash: text('hash').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: index('api_key_hash_idx').on(t.hash),
    byCustomer: index('api_key_customer_idx').on(t.customerId),
  }),
);

export const reservations = pgTable(
  'reservation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    workId: text('work_id').notNull().unique(),
    kind: reservationKind('kind').notNull(),
    amountUsdCents: bigint('amount_usd_cents', { mode: 'bigint' }),
    amountTokens: bigint('amount_tokens', { mode: 'bigint' }),
    state: reservationState('state').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    byCustomer: index('reservation_customer_idx').on(t.customerId),
  }),
);

export const usageRecords = pgTable(
  'usage_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    workId: text('work_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull(),
    nodeUrl: text('node_url').notNull(),
    promptTokensReported: integer('prompt_tokens_reported').notNull(),
    completionTokensReported: integer('completion_tokens_reported').notNull(),
    promptTokensLocal: integer('prompt_tokens_local'),
    completionTokensLocal: integer('completion_tokens_local'),
    costUsdCents: bigint('cost_usd_cents', { mode: 'bigint' }).notNull(),
    nodeCostWei: text('node_cost_wei').notNull(),
    status: usageStatus('status').notNull(),
    errorCode: text('error_code'),
  },
  (t) => ({
    byCustomer: index('usage_record_customer_idx').on(t.customerId, t.createdAt),
    byWork: index('usage_record_work_idx').on(t.workId),
  }),
);

export const topups = pgTable(
  'topup',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    stripeSessionId: text('stripe_session_id').notNull().unique(),
    amountUsdCents: bigint('amount_usd_cents', { mode: 'bigint' }).notNull(),
    status: topupStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disputedAt: timestamp('disputed_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
  },
  (t) => ({
    byCustomer: index('topup_customer_idx').on(t.customerId),
  }),
);

export const stripeWebhookEvents = pgTable('stripe_webhook_event', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payload: text('payload').notNull(),
});

export const adminAuditEvents = pgTable(
  'admin_audit_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetId: text('target_id'),
    payload: text('payload'),
    statusCode: integer('status_code').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byActorTime: index('admin_audit_event_actor_time_idx').on(t.actor, t.occurredAt),
  }),
);

export const nodeHealth = pgTable('node_health', {
  nodeId: text('node_id').primaryKey(),
  status: nodeHealthStatus('status').notNull(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  circuitOpenedAt: timestamp('circuit_opened_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nodeHealthEvents = pgTable(
  'node_health_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: text('node_id').notNull(),
    kind: nodeHealthEventKind('kind').notNull(),
    detail: text('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byNodeTime: index('node_health_event_node_time_idx').on(t.nodeId, t.occurredAt),
  }),
);

export const schema = {
  customers,
  apiKeys,
  reservations,
  usageRecords,
  topups,
  stripeWebhookEvents,
  adminAuditEvents,
  nodeHealth,
  nodeHealthEvents,
  customerTier,
  customerStatus,
  usageStatus,
  topupStatus,
  reservationState,
  reservationKind,
  nodeHealthStatus,
  nodeHealthEventKind,
};
