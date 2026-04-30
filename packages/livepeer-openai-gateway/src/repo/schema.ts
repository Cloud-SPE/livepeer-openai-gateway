import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Shell-owned namespace. Mirrors `CREATE SCHEMA app` in the
// 0000_init.sql migration so Drizzle qualifies every query as
// `app.<table>`. There are no foreign keys from app.* into engine.*.
export const appSchema = pgSchema('app');

// ── Enums ───────────────────────────────────────────────────────────────────
export const customerTier = pgEnum('customer_tier', ['free', 'prepaid']);
export const customerStatus = pgEnum('customer_status', ['active', 'suspended', 'closed']);
export const topupStatus = pgEnum('topup_status', ['pending', 'succeeded', 'failed', 'refunded']);
export const reservationState = pgEnum('reservation_state', ['open', 'committed', 'refunded']);
export const reservationKind = pgEnum('reservation_kind', ['prepaid', 'free']);

// ── Tables ──────────────────────────────────────────────────────────────────

export const customers = appSchema.table('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  tier: customerTier('tier').notNull(),
  status: customerStatus('status').notNull().default('active'),
  rateLimitTier: text('rate_limit_tier').notNull().default('default'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  balanceUsdCents: bigint('balance_usd_cents', { mode: 'bigint' }).notNull(),
  reservedUsdCents: bigint('reserved_usd_cents', { mode: 'bigint' }).notNull(),
  quotaTokensRemaining: bigint('quota_tokens_remaining', { mode: 'bigint' }),
  quotaMonthlyAllowance: bigint('quota_monthly_allowance', { mode: 'bigint' }),
  quotaReservedTokens: bigint('quota_reserved_tokens', { mode: 'bigint' }).notNull(),
  quotaResetAt: timestamp('quota_reset_at', { withTimezone: true }),
});

export const apiKeys = appSchema.table(
  'api_keys',
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

export const reservations = appSchema.table(
  'reservations',
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

export const topups = appSchema.table(
  'topups',
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

export const stripeWebhookEvents = appSchema.table('stripe_webhook_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payload: text('payload').notNull(),
});

export const adminAuditEvents = appSchema.table(
  'admin_audit_events',
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

export const idempotencyState = pgEnum('idempotency_state', ['pending', 'completed']);
export const idempotencyEncoding = pgEnum('idempotency_encoding', ['utf8', 'base64']);

export const idempotencyRequests = appSchema.table(
  'idempotency_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestMethod: text('request_method').notNull(),
    requestPath: text('request_path').notNull(),
    requestHash: text('request_hash').notNull(),
    state: idempotencyState('state').notNull().default('pending'),
    responseStatusCode: integer('response_status_code'),
    responseContentType: text('response_content_type'),
    responseEncoding: idempotencyEncoding('response_encoding'),
    responseBody: text('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    byCustomerAndKey: uniqueIndex('idempotency_requests_customer_key_uniq').on(
      t.customerId,
      t.idempotencyKey,
    ),
    byCreatedAt: index('idempotency_requests_created_at_idx').on(t.createdAt),
  }),
);

// ── Rate-card tables (per exec-plan 0030) ───────────────────────────────────
//
// Operator-managed pricing. Each capability has its own table with an
// `is_pattern` discriminator handling exact-vs-glob entries. Resolution
// at read time: exact → patterns by sort_order ascending → null. The
// engine's RateCardResolver consumer (rateCard.service.ts) materializes
// these into a RateCardSnapshot and answers per-request lookups.

export const rateCardChatTiers = appSchema.table('rate_card_chat_tiers', {
  tier: text('tier').primaryKey(),
  inputUsdPerMillion: numeric('input_usd_per_million', { precision: 20, scale: 8 }).notNull(),
  outputUsdPerMillion: numeric('output_usd_per_million', { precision: 20, scale: 8 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rateCardChatModels = appSchema.table(
  'rate_card_chat_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelOrPattern: text('model_or_pattern').notNull(),
    isPattern: boolean('is_pattern').notNull(),
    tier: text('tier')
      .notNull()
      .references(() => rateCardChatTiers.tier),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('rate_card_chat_models_uniq').on(t.modelOrPattern, t.isPattern),
  }),
);

export const rateCardEmbeddings = appSchema.table(
  'rate_card_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelOrPattern: text('model_or_pattern').notNull(),
    isPattern: boolean('is_pattern').notNull(),
    usdPerMillionTokens: numeric('usd_per_million_tokens', {
      precision: 20,
      scale: 8,
    }).notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('rate_card_embeddings_uniq').on(t.modelOrPattern, t.isPattern),
  }),
);

export const rateCardImages = appSchema.table(
  'rate_card_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelOrPattern: text('model_or_pattern').notNull(),
    isPattern: boolean('is_pattern').notNull(),
    size: text('size').notNull(),
    quality: text('quality').notNull(),
    usdPerImage: numeric('usd_per_image', { precision: 20, scale: 8 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('rate_card_images_uniq').on(t.modelOrPattern, t.isPattern, t.size, t.quality),
  }),
);

export const rateCardSpeech = appSchema.table(
  'rate_card_speech',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelOrPattern: text('model_or_pattern').notNull(),
    isPattern: boolean('is_pattern').notNull(),
    usdPerMillionChars: numeric('usd_per_million_chars', {
      precision: 20,
      scale: 8,
    }).notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('rate_card_speech_uniq').on(t.modelOrPattern, t.isPattern),
  }),
);

export const rateCardTranscriptions = appSchema.table(
  'rate_card_transcriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelOrPattern: text('model_or_pattern').notNull(),
    isPattern: boolean('is_pattern').notNull(),
    usdPerMinute: numeric('usd_per_minute', { precision: 20, scale: 8 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('rate_card_transcriptions_uniq').on(t.modelOrPattern, t.isPattern),
  }),
);

// ── Shell-native retail pricing (v3.0.1 prep) ──────────────────────────────
//
// These tables are the shell-owned pricing source of truth for the new
// `(capability, offering, customer_tier)` model. While the installed
// engine still consumes the legacy rate-card snapshot, the pricing
// service synthesizes that older shape from the `prepaid` view here.

export const retailPriceCatalog = appSchema.table(
  'retail_price_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capability: text('capability').notNull(),
    offering: text('offering').notNull(),
    customerTier: text('customer_tier').notNull(),
    priceKind: text('price_kind').notNull().default('default'),
    unit: text('unit').notNull(),
    usdPerUnit: numeric('usd_per_unit', { precision: 20, scale: 8 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('retail_price_catalog_uniq').on(
      t.capability,
      t.offering,
      t.customerTier,
      t.priceKind,
    ),
  }),
);

export const retailPriceAliases = appSchema.table(
  'retail_price_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capability: text('capability').notNull(),
    modelOrPattern: text('model_or_pattern').notNull(),
    isPattern: boolean('is_pattern').notNull(),
    offering: text('offering').notNull(),
    size: text('size').notNull().default(''),
    quality: text('quality').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('retail_price_aliases_uniq').on(
      t.capability,
      t.modelOrPattern,
      t.isPattern,
      t.size,
      t.quality,
    ),
  }),
);

export const schema = {
  customers,
  apiKeys,
  reservations,
  topups,
  stripeWebhookEvents,
  adminAuditEvents,
  idempotencyRequests,
  rateCardChatTiers,
  rateCardChatModels,
  rateCardEmbeddings,
  rateCardImages,
  rateCardSpeech,
  rateCardTranscriptions,
  retailPriceCatalog,
  retailPriceAliases,
  customerTier,
  customerStatus,
  topupStatus,
  reservationState,
  reservationKind,
  idempotencyState,
  idempotencyEncoding,
};
