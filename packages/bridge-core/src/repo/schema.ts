import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Engine-owned namespace. Mirrors `CREATE SCHEMA engine` in the
// 0000_init.sql migration so Drizzle qualifies every query as
// `engine.<table>`.
export const engineSchema = pgSchema('engine');

// ── Enums ───────────────────────────────────────────────────────────────────
export const usageStatus = pgEnum('usage_status', ['success', 'partial', 'failed']);
export const usageRecordKind = pgEnum('usage_record_kind', [
  'chat',
  'embeddings',
  'images',
  'speech',
  'transcriptions',
]);
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

// ── Tables ──────────────────────────────────────────────────────────────────

export const nodeHealth = engineSchema.table('node_health', {
  nodeId: text('node_id').primaryKey(),
  status: nodeHealthStatus('status').notNull(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  circuitOpenedAt: timestamp('circuit_opened_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nodeHealthEvents = engineSchema.table(
  'node_health_events',
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

export const usageRecords = engineSchema.table(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callerId: text('caller_id').notNull(),
    workId: text('work_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    kind: usageRecordKind('kind').notNull().default('chat'),
    model: text('model').notNull(),
    nodeUrl: text('node_url').notNull(),
    promptTokensReported: integer('prompt_tokens_reported'),
    completionTokensReported: integer('completion_tokens_reported'),
    promptTokensLocal: integer('prompt_tokens_local'),
    completionTokensLocal: integer('completion_tokens_local'),
    imageCount: integer('image_count'),
    charCount: integer('char_count'),
    durationSeconds: integer('duration_seconds'),
    costUsdCents: bigint('cost_usd_cents', { mode: 'bigint' }).notNull(),
    nodeCostWei: text('node_cost_wei').notNull(),
    status: usageStatus('status').notNull(),
    errorCode: text('error_code'),
  },
  (t) => ({
    byCaller: index('usage_record_caller_idx').on(t.callerId, t.createdAt),
    byWork: index('usage_record_work_idx').on(t.workId),
    kindColumnsConsistent: check(
      'usage_record_kind_columns_chk',
      sql`
        (
          ${t.kind} = 'chat' AND ${t.promptTokensReported} IS NOT NULL AND ${t.completionTokensReported} IS NOT NULL
        ) OR (
          ${t.kind} = 'embeddings' AND ${t.promptTokensReported} IS NOT NULL
        ) OR (
          ${t.kind} = 'images' AND ${t.imageCount} IS NOT NULL
        ) OR (
          ${t.kind} = 'speech' AND ${t.charCount} IS NOT NULL
        ) OR (
          ${t.kind} = 'transcriptions' AND ${t.durationSeconds} IS NOT NULL
        )
      `,
    ),
  }),
);

export const schema = {
  usageRecords,
  nodeHealth,
  nodeHealthEvents,
  usageStatus,
  usageRecordKind,
  nodeHealthStatus,
  nodeHealthEventKind,
};
