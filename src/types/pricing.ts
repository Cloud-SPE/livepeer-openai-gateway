import { z } from 'zod';

export const PricingTierSchema = z.enum(['starter', 'standard', 'pro']);
export type PricingTier = z.infer<typeof PricingTierSchema>;

export const UsdPerMillionTokensSchema = z.number().positive();
export type UsdPerMillionTokens = z.infer<typeof UsdPerMillionTokensSchema>;

export const ChatRateCardEntrySchema = z.object({
  tier: PricingTierSchema,
  inputUsdPerMillion: UsdPerMillionTokensSchema,
  outputUsdPerMillion: UsdPerMillionTokensSchema,
});
export type ChatRateCardEntry = z.infer<typeof ChatRateCardEntrySchema>;

export const ChatRateCardSchema = z.object({
  version: z.string().min(1),
  effectiveAt: z.coerce.date(),
  entries: z.array(ChatRateCardEntrySchema).length(3),
});
export type ChatRateCard = z.infer<typeof ChatRateCardSchema>;

export const ModelIdSchema = z.string().min(1).max(256);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const ModelTierMapSchema = z.record(ModelIdSchema, PricingTierSchema);
export type ModelTierMap = z.infer<typeof ModelTierMapSchema>;

export const EmbeddingsRateCardEntrySchema = z.object({
  model: ModelIdSchema,
  usdPerMillionTokens: UsdPerMillionTokensSchema,
});
export type EmbeddingsRateCardEntry = z.infer<typeof EmbeddingsRateCardEntrySchema>;

export const EmbeddingsRateCardSchema = z.object({
  version: z.string().min(1),
  effectiveAt: z.coerce.date(),
  entries: z.array(EmbeddingsRateCardEntrySchema).min(1),
});
export type EmbeddingsRateCard = z.infer<typeof EmbeddingsRateCardSchema>;

export const ImageSizeSchema = z.enum(['1024x1024', '1024x1792', '1792x1024']);
export type ImageSize = z.infer<typeof ImageSizeSchema>;

export const ImageQualitySchema = z.enum(['standard', 'hd']);
export type ImageQuality = z.infer<typeof ImageQualitySchema>;

export const UsdPerImageSchema = z.number().positive();
export type UsdPerImage = z.infer<typeof UsdPerImageSchema>;

export const ImagesRateCardEntrySchema = z.object({
  model: ModelIdSchema,
  size: ImageSizeSchema,
  quality: ImageQualitySchema,
  usdPerImage: UsdPerImageSchema,
});
export type ImagesRateCardEntry = z.infer<typeof ImagesRateCardEntrySchema>;

export const ImagesRateCardSchema = z.object({
  version: z.string().min(1),
  effectiveAt: z.coerce.date(),
  entries: z.array(ImagesRateCardEntrySchema).min(1),
});
export type ImagesRateCard = z.infer<typeof ImagesRateCardSchema>;

export const UsdPerMillionCharsSchema = z.number().positive();
export type UsdPerMillionChars = z.infer<typeof UsdPerMillionCharsSchema>;

export const SpeechRateCardEntrySchema = z.object({
  model: ModelIdSchema,
  usdPerMillionChars: UsdPerMillionCharsSchema,
});
export type SpeechRateCardEntry = z.infer<typeof SpeechRateCardEntrySchema>;

export const SpeechRateCardSchema = z.object({
  version: z.string().min(1),
  effectiveAt: z.coerce.date(),
  entries: z.array(SpeechRateCardEntrySchema).min(1),
});
export type SpeechRateCard = z.infer<typeof SpeechRateCardSchema>;

export const UsdPerMinuteSchema = z.number().positive();
export type UsdPerMinute = z.infer<typeof UsdPerMinuteSchema>;

export const TranscriptionsRateCardEntrySchema = z.object({
  model: ModelIdSchema,
  usdPerMinute: UsdPerMinuteSchema,
});
export type TranscriptionsRateCardEntry = z.infer<typeof TranscriptionsRateCardEntrySchema>;

export const TranscriptionsRateCardSchema = z.object({
  version: z.string().min(1),
  effectiveAt: z.coerce.date(),
  entries: z.array(TranscriptionsRateCardEntrySchema).min(1),
});
export type TranscriptionsRateCard = z.infer<typeof TranscriptionsRateCardSchema>;
