import { eq, sql } from 'drizzle-orm';
import type { Db } from './db.js';
import { customers } from './schema.js';

export type CustomerRow = typeof customers.$inferSelect;
export type CustomerInsert = typeof customers.$inferInsert;

export async function insertCustomer(db: Db, values: CustomerInsert): Promise<CustomerRow> {
  const [row] = await db.insert(customers).values(values).returning();
  if (!row) throw new Error('insertCustomer: no row returned');
  return row;
}

export async function findById(db: Db, id: string): Promise<CustomerRow | null> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function selectForUpdate(db: Db, id: string): Promise<CustomerRow | null> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).for('update').limit(1);
  return rows[0] ?? null;
}

export async function updateBalanceFields(
  db: Db,
  id: string,
  values: { balanceUsdCents?: bigint; reservedUsdCents?: bigint },
): Promise<void> {
  await db.update(customers).set(values).where(eq(customers.id, id));
}

export async function updateQuotaFields(
  db: Db,
  id: string,
  values: { quotaTokensRemaining?: bigint; quotaReservedTokens?: bigint },
): Promise<void> {
  await db.update(customers).set(values).where(eq(customers.id, id));
}

export async function incrementBalance(db: Db, id: string, deltaCents: bigint): Promise<void> {
  await db
    .update(customers)
    .set({ balanceUsdCents: sql`${customers.balanceUsdCents} + ${deltaCents.toString()}::bigint` })
    .where(eq(customers.id, id));
}
