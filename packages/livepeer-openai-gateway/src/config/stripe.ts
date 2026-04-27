import { z } from 'zod';

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly priceMinCents: number;
  readonly priceMaxCents: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

const EnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_MIN_CENTS: z.coerce.number().int().positive().default(500),
  STRIPE_PRICE_MAX_CENTS: z.coerce.number().int().positive().default(50_000),
  STRIPE_SUCCESS_URL: z.string().url(),
  STRIPE_CANCEL_URL: z.string().url(),
});

export function loadStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const parsed = EnvSchema.parse(env);
  return {
    secretKey: parsed.STRIPE_SECRET_KEY,
    webhookSecret: parsed.STRIPE_WEBHOOK_SECRET,
    priceMinCents: parsed.STRIPE_PRICE_MIN_CENTS,
    priceMaxCents: parsed.STRIPE_PRICE_MAX_CENTS,
    successUrl: parsed.STRIPE_SUCCESS_URL,
    cancelUrl: parsed.STRIPE_CANCEL_URL,
  };
}
