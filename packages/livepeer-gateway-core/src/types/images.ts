import { z } from 'zod';
import { ImageQualitySchema, ImageSizeSchema, ModelIdSchema } from './pricing.js';

export const ImageStyleSchema = z.enum(['vivid', 'natural']);
export type ImageStyle = z.infer<typeof ImageStyleSchema>;

export const ImageResponseFormatSchema = z.enum(['url', 'b64_json']);
export type ImageResponseFormat = z.infer<typeof ImageResponseFormatSchema>;

export const ImagesGenerationRequestSchema = z.object({
  model: ModelIdSchema,
  prompt: z.string().min(1).max(4_000),
  n: z.number().int().positive().max(10).optional(),
  size: ImageSizeSchema.optional(),
  quality: ImageQualitySchema.optional(),
  style: ImageStyleSchema.optional(),
  response_format: ImageResponseFormatSchema.optional(),
  user: z.string().optional(),
});
export type ImagesGenerationRequest = z.infer<typeof ImagesGenerationRequestSchema>;

export const ImageSchema = z.object({
  url: z.string().url().optional(),
  b64_json: z.string().optional(),
  revised_prompt: z.string().optional(),
});
export type Image = z.infer<typeof ImageSchema>;

export const ImagesResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  data: z.array(ImageSchema),
});
export type ImagesResponse = z.infer<typeof ImagesResponseSchema>;

export const IMAGES_DEFAULT_N = 1;
export const IMAGES_DEFAULT_SIZE = '1024x1024' as const;
export const IMAGES_DEFAULT_QUALITY = 'standard' as const;
export const IMAGES_DEFAULT_RESPONSE_FORMAT = 'url' as const;
