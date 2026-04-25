import { z } from 'zod';
import type { NodeCapability } from './node.js';

/**
 * Single source of truth for the bridge's mapping between the
 * `NodeCapability` short-form enum (used in nodes.yaml + internal
 * routing) and the canonical capability strings the worker emits
 * (used in /capabilities, /quote, /quotes, and as the key in
 * `NodeEntry.quotes`).
 *
 * Worker contract: see livepeer-payment-library/docs/design-docs/shared-yaml.md
 * for the canonical-string convention `<domain>:<uri-path>`.
 */
export const CAPABILITY_STRINGS = {
  chat: 'openai:/v1/chat/completions',
  embeddings: 'openai:/v1/embeddings',
  images: 'openai:/v1/images/generations',
  imagesEdits: 'openai:/v1/images/edits',
  speech: 'openai:/v1/audio/speech',
  transcriptions: 'openai:/v1/audio/transcriptions',
} as const satisfies Record<NodeCapability, string>;

/**
 * Closed set of canonical capability strings the bridge accepts at any
 * worker-facing boundary. Use this at parse sites (e.g. validating a
 * `capability` field on `/quotes` response entries) so a typo in a
 * worker's emit is caught at the boundary rather than at routing time.
 */
export const CapabilityStringSchema = z.enum([
  CAPABILITY_STRINGS.chat,
  CAPABILITY_STRINGS.embeddings,
  CAPABILITY_STRINGS.images,
  CAPABILITY_STRINGS.imagesEdits,
  CAPABILITY_STRINGS.speech,
  CAPABILITY_STRINGS.transcriptions,
]);

export type CapabilityString = z.infer<typeof CapabilityStringSchema>;

/**
 * Maps a short-form capability to its canonical worker-emitted string.
 * Use everywhere the bridge needs to look up a NodeEntry's quote for
 * a specific capability (`node.quotes.get(capabilityString('chat'))`).
 */
export function capabilityString(cap: NodeCapability): CapabilityString {
  return CAPABILITY_STRINGS[cap];
}
