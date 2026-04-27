import { and, asc, eq, gt } from 'drizzle-orm';
import type { Db } from '../repo/db.js';
import { reservations } from '../repo/schema.js';

export type ReservationRow = typeof reservations.$inferSelect;
export type ReservationInsert = typeof reservations.$inferInsert;
export type ReservationState = ReservationRow['state'];

export async function insertReservation(
  db: Db,
  values: ReservationInsert,
): Promise<ReservationRow> {
  const [row] = await db.insert(reservations).values(values).returning();
  if (!row) throw new Error('insertReservation: no row returned');
  return row;
}

export async function findById(db: Db, id: string): Promise<ReservationRow | null> {
  const rows = await db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateState(
  db: Db,
  id: string,
  state: ReservationState,
  resolvedAt: Date,
): Promise<void> {
  await db.update(reservations).set({ state, resolvedAt }).where(eq(reservations.id, id));
}

/**
 * List reservations in a given state, oldest first — operators investigating
 * stuck reservations want the longest-open ones at the top. Cursor pages by
 * (createdAt, id) ascending; pass the last seen createdAt to continue.
 */
export async function listByState(
  db: Db,
  options: { state: ReservationState; limit: number; cursorCreatedAt?: Date },
): Promise<ReservationRow[]> {
  const where = options.cursorCreatedAt
    ? and(eq(reservations.state, options.state), gt(reservations.createdAt, options.cursorCreatedAt))
    : eq(reservations.state, options.state);
  return db
    .select()
    .from(reservations)
    .where(where)
    .orderBy(asc(reservations.createdAt))
    .limit(options.limit);
}
