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
export const CAPABILITY_STRINGS: Record<NodeCapability, string> = {
  chat: 'openai:/v1/chat/completions',
  embeddings: 'openai:/v1/embeddings',
  images: 'openai:/v1/images/generations',
  imagesEdits: 'openai:/v1/images/edits',
  speech: 'openai:/v1/audio/speech',
  transcriptions: 'openai:/v1/audio/transcriptions',
};

/**
 * Maps a short-form capability to its canonical worker-emitted string.
 * Use everywhere the bridge needs to look up a NodeEntry's quote for
 * a specific capability (`node.quotes.get(capabilityString('chat'))`).
 */
export function capabilityString(cap: NodeCapability): string {
  return CAPABILITY_STRINGS[cap];
}
