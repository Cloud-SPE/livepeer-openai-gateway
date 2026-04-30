import { and, eq } from 'drizzle-orm';
import type { Db } from '../repo/db.js';
import { idempotencyRequests } from './schema.js';

export type IdempotencyRow = typeof idempotencyRequests.$inferSelect;

export async function findByCustomerAndKey(
  db: Db,
  customerId: string,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  const rows = await db
    .select()
    .from(idempotencyRequests)
    .where(
      and(
        eq(idempotencyRequests.customerId, customerId),
        eq(idempotencyRequests.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertPending(
  db: Db,
  input: {
    customerId: string;
    idempotencyKey: string;
    requestMethod: string;
    requestPath: string;
    requestHash: string;
  },
): Promise<IdempotencyRow> {
  const [row] = await db
    .insert(idempotencyRequests)
    .values({
      customerId: input.customerId,
      idempotencyKey: input.idempotencyKey,
      requestMethod: input.requestMethod,
      requestPath: input.requestPath,
      requestHash: input.requestHash,
      state: 'pending',
    })
    .returning();
  if (!row) throw new Error('insertPending: no row returned');
  return row;
}

export async function markCompleted(
  db: Db,
  id: string,
  input: {
    responseStatusCode: number;
    responseContentType: string | null;
    responseEncoding: 'utf8' | 'base64';
    responseBody: string;
  },
): Promise<void> {
  await db
    .update(idempotencyRequests)
    .set({
      state: 'completed',
      responseStatusCode: input.responseStatusCode,
      responseContentType: input.responseContentType,
      responseEncoding: input.responseEncoding,
      responseBody: input.responseBody,
      completedAt: new Date(),
    })
    .where(eq(idempotencyRequests.id, id));
}

export async function deleteById(db: Db, id: string): Promise<void> {
  await db.delete(idempotencyRequests).where(eq(idempotencyRequests.id, id));
}
