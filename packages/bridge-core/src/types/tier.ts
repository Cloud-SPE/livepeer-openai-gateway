import { z } from 'zod';

/**
 * Engine-side tier enum used by the routing layer (selectNode + retry).
 * Shell's Customer entity carries a tier string that this enum closes; the
 * shell's AuthResolver supplies it on `Caller.tier`.
 */
export const CustomerTierSchema = z.enum(['free', 'prepaid']);
export type CustomerTier = z.infer<typeof CustomerTierSchema>;
