import type { Db } from './db.js';
import { usageRecords } from './schema.js';

export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type UsageRecordInsert = typeof usageRecords.$inferInsert;

export async function insertUsageRecord(
  db: Db,
  values: UsageRecordInsert,
): Promise<UsageRecordRow> {
  const [row] = await db.insert(usageRecords).values(values).returning();
  if (!row) throw new Error('insertUsageRecord: no row returned');
  return row;
}
