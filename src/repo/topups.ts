import { eq } from 'drizzle-orm';
import type { Db } from './db.js';
import { topups } from './schema.js';

export type TopupRow = typeof topups.$inferSelect;
export type TopupInsert = typeof topups.$inferInsert;
export type TopupStatus = TopupRow['status'];

export async function insertTopup(db: Db, values: TopupInsert): Promise<TopupRow> {
  const [row] = await db.insert(topups).values(values).returning();
  if (!row) throw new Error('insertTopup: no row returned');
  return row;
}

export async function updateTopupStatus(
  db: Db,
  stripeSessionId: string,
  status: TopupStatus,
): Promise<void> {
  await db.update(topups).set({ status }).where(eq(topups.stripeSessionId, stripeSessionId));
}
