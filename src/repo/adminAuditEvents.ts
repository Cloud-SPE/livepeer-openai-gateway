import type { Db } from './db.js';
import { adminAuditEvents } from './schema.js';

export type AdminAuditEventRow = typeof adminAuditEvents.$inferSelect;
export type AdminAuditEventInsert = typeof adminAuditEvents.$inferInsert;

export async function recordEvent(
  db: Db,
  values: AdminAuditEventInsert,
): Promise<AdminAuditEventRow> {
  const [row] = await db.insert(adminAuditEvents).values(values).returning();
  if (!row) throw new Error('recordEvent: no row returned');
  return row;
}
