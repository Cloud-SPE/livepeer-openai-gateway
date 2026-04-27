import { sql } from 'drizzle-orm';
import type { Db } from '../repo/db.js';
import { stripeWebhookEvents } from '../repo/schema.js';

export type StripeWebhookEventRow = typeof stripeWebhookEvents.$inferSelect;

/**
 * Insert a webhook event row. Returns true if the row was newly inserted
 * (caller should process the event), false if the event_id already existed
 * (duplicate Stripe retry — caller should skip).
 */
export async function insertIfNew(
  db: Db,
  eventId: string,
  type: string,
  payload: string,
): Promise<boolean> {
  const result = await db.execute(
    sql`
      INSERT INTO app.stripe_webhook_events (event_id, type, payload)
      VALUES (${eventId}, ${type}, ${payload})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `,
  );
  return result.rows.length > 0;
}
