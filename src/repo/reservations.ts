import { eq } from 'drizzle-orm';
import type { Db } from './db.js';
import { reservations } from './schema.js';

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
