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

export const customers = pgTable(
  'customer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    apiKeyHash: text('api_key_hash').notNull(),
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
  },
  (t) => ({
    byApiKeyHash: index('customer_api_key_hash_idx').on(t.apiKeyHash),
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
  },
  (t) => ({
    byCustomer: index('topup_customer_idx').on(t.customerId),
  }),
);

export const schema = {
  customers,
  reservations,
  usageRecords,
  topups,
  customerTier,
  customerStatus,
  usageStatus,
  topupStatus,
  reservationState,
  reservationKind,
};
