import { z } from 'zod';
import { CustomerIdSchema } from './customer.js';
import { NodeIdSchema } from './node.js';

export const WorkIdSchema = z.string().min(1).max(256).brand<'WorkId'>();
export type WorkId = z.infer<typeof WorkIdSchema>;

export const PaymentBlobSchema = z.instanceof(Uint8Array);
export type PaymentBlob = z.infer<typeof PaymentBlobSchema>;

export const ReservationIdSchema = z.string().uuid().brand<'ReservationId'>();
export type ReservationId = z.infer<typeof ReservationIdSchema>;

export const LedgerDebitSchema = z.object({
  reservationId: ReservationIdSchema,
  customerId: CustomerIdSchema,
  workId: WorkIdSchema,
  nodeId: NodeIdSchema,
  actualUsdCents: z.bigint().nonnegative(),
  actualTokens: z.bigint().nonnegative(),
  committedAt: z.coerce.date(),
});
export type LedgerDebit = z.infer<typeof LedgerDebitSchema>;

export const LedgerRefundSchema = z.object({
  reservationId: ReservationIdSchema,
  customerId: CustomerIdSchema,
  workId: WorkIdSchema,
  refundUsdCents: z.bigint().nonnegative(),
  reason: z.enum(['reservation_unused', 'partial_failure', 'full_failure']),
  refundedAt: z.coerce.date(),
});
export type LedgerRefund = z.infer<typeof LedgerRefundSchema>;
