import { eq } from 'drizzle-orm';
import type { Db } from './db.js';
import { nodeHealth, nodeHealthEvents } from './schema.js';

export type NodeHealthRow = typeof nodeHealth.$inferSelect;
export type NodeHealthInsert = typeof nodeHealth.$inferInsert;
export type NodeHealthEventRow = typeof nodeHealthEvents.$inferSelect;
export type NodeHealthEventInsert = typeof nodeHealthEvents.$inferInsert;
export type NodeHealthStatus = NodeHealthRow['status'];
export type NodeHealthEventKind = NodeHealthEventRow['kind'];

export async function upsertNodeHealth(db: Db, values: NodeHealthInsert): Promise<void> {
  await db
    .insert(nodeHealth)
    .values(values)
    .onConflictDoUpdate({
      target: nodeHealth.nodeId,
      set: {
        status: values.status,
        consecutiveFailures: values.consecutiveFailures ?? 0,
        lastSuccessAt: values.lastSuccessAt ?? null,
        lastFailureAt: values.lastFailureAt ?? null,
        circuitOpenedAt: values.circuitOpenedAt ?? null,
        updatedAt: values.updatedAt ?? new Date(),
      },
    });
}

export async function findNodeHealth(db: Db, nodeId: string): Promise<NodeHealthRow | null> {
  const rows = await db.select().from(nodeHealth).where(eq(nodeHealth.nodeId, nodeId)).limit(1);
  return rows[0] ?? null;
}

export async function insertNodeHealthEvent(
  db: Db,
  values: NodeHealthEventInsert,
): Promise<NodeHealthEventRow> {
  const [row] = await db.insert(nodeHealthEvents).values(values).returning();
  if (!row) throw new Error('insertNodeHealthEvent: no row returned');
  return row;
}

export async function listEventsForNode(db: Db, nodeId: string): Promise<NodeHealthEventRow[]> {
  return db.select().from(nodeHealthEvents).where(eq(nodeHealthEvents.nodeId, nodeId));
}
