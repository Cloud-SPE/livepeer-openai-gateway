import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
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

export interface CustomerSearchInput {
  q?: string;
  tier?: 'free' | 'prepaid';
  status?: 'active' | 'suspended' | 'closed';
  limit: number;
  cursorCreatedAt?: Date;
}

/**
 * Operator-side customer search. Substring match on email or exact match on
 * id. ILIKE works fine to ~100k rows; past that, add pg_trgm + GIN. Cursor
 * pages descending by createdAt (then id) for stability under inserts.
 */
export async function search(db: Db, input: CustomerSearchInput): Promise<CustomerRow[]> {
  const conds = [];
  if (input.q && input.q.length > 0) {
    const like = `%${input.q}%`;
    // Match on email substring; also match exact id when the query is a
    // UUID (PG would reject a non-uuid string cast against the id column).
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.q);
    conds.push(isUuid ? or(ilike(customers.email, like), eq(customers.id, input.q)) : ilike(customers.email, like));
  }
  if (input.tier) conds.push(eq(customers.tier, input.tier));
  if (input.status) conds.push(eq(customers.status, input.status));
  if (input.cursorCreatedAt) conds.push(lt(customers.createdAt, input.cursorCreatedAt));

  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  const builder = db.select().from(customers);
  const filtered = where ? builder.where(where) : builder;
  return filtered.orderBy(desc(customers.createdAt), desc(customers.id)).limit(input.limit);
}
