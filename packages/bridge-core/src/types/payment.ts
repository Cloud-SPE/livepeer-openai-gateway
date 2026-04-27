import { z } from 'zod';

export const WorkIdSchema = z.string().min(1).max(256).brand<'WorkId'>();
export type WorkId = z.infer<typeof WorkIdSchema>;

export const PaymentBlobSchema = z.instanceof(Uint8Array);
export type PaymentBlob = z.infer<typeof PaymentBlobSchema>;

export const ReservationIdSchema = z.string().uuid().brand<'ReservationId'>();
export type ReservationId = z.infer<typeof ReservationIdSchema>;
