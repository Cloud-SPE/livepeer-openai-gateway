import { z } from 'zod';
import { ModelIdSchema } from './pricing.js';

// OpenAI caps `input` at 4096 characters; mirroring the cap at the
// boundary means billing never sees an oversized request body.
export const SPEECH_MAX_INPUT_CHARS = 4096;

export const SpeechResponseFormatSchema = z.enum([
  'mp3',
  'opus',
  'aac',
  'flac',
  'wav',
  'pcm',
]);
export type SpeechResponseFormat = z.infer<typeof SpeechResponseFormatSchema>;

export const SpeechRequestSchema = z.object({
  model: ModelIdSchema,
  input: z.string().min(1).max(SPEECH_MAX_INPUT_CHARS),
  voice: z.string().min(1),
  response_format: SpeechResponseFormatSchema.optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
});
export type SpeechRequest = z.infer<typeof SpeechRequestSchema>;
