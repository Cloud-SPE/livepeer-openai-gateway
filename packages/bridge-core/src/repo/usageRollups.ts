import { sql } from 'drizzle-orm';
import type { Db } from './db.js';

export type GroupBy = 'day' | 'model' | 'capability';

export interface UsageRollupRow {
  bucket: string;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  costUsdCents: bigint;
  successCount: number;
  partialCount: number;
  failedCount: number;
}

export interface UsageRollupInput {
  customerId: string;
  from: Date;
  to: Date;
  groupBy: GroupBy;
}

/**
 * Aggregate usage_records for one customer between [from, to) grouped by the
 * requested dimension. Tokens are summed from the *_local columns when present
 * and fall back to *_reported (matches the prior server-side aggregation).
 */
export async function rollup(db: Db, input: UsageRollupInput): Promise<UsageRollupRow[]> {
  const bucketExpr =
    input.groupBy === 'day'
      ? sql`to_char(date_trunc('day', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
      : input.groupBy === 'model'
        ? sql`model`
        : sql`kind`;

  const result = await db.execute(sql<{
    bucket: string;
    prompt_tokens: string;
    completion_tokens: string;
    requests: string;
    cost_usd_cents: string;
    success_count: string;
    partial_count: string;
    failed_count: string;
  }>`
    SELECT
      ${bucketExpr} AS bucket,
      COALESCE(SUM(COALESCE(prompt_tokens_local, prompt_tokens_reported, 0)), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(COALESCE(completion_tokens_local, completion_tokens_reported, 0)), 0)::bigint AS completion_tokens,
      COUNT(*)::bigint AS requests,
      COALESCE(SUM(cost_usd_cents), 0)::bigint AS cost_usd_cents,
      COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
      COUNT(*) FILTER (WHERE status = 'partial')::bigint AS partial_count,
      COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed_count
    FROM usage_record
    WHERE customer_id = ${input.customerId}
      AND created_at >= ${input.from}
      AND created_at < ${input.to}
    GROUP BY bucket
    ORDER BY bucket DESC
  `);

  // drizzle execute returns { rows: [...] } for pg. Row shape is fixed by the
  // SELECT above (each column typed `bigint` via ::bigint cast which pg
  // returns as a string). COALESCE in the SQL guarantees non-null.
  interface RawRow {
    bucket: string;
    prompt_tokens: string;
    completion_tokens: string;
    requests: string;
    cost_usd_cents: string;
    success_count: string;
    partial_count: string;
    failed_count: string;
  }
  const rows = (result as unknown as { rows: RawRow[] }).rows;
  return rows.map((r) => ({
    bucket: r.bucket,
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    requests: Number(r.requests),
    costUsdCents: BigInt(r.cost_usd_cents),
    successCount: Number(r.success_count),
    partialCount: Number(r.partial_count),
    failedCount: Number(r.failed_count),
  }));
}
