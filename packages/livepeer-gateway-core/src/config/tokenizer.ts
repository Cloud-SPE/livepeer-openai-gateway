import type { EncodingName } from '../providers/tokenizer.js';

const MODEL_TO_ENCODING: ReadonlyMap<string, EncodingName> = new Map<string, EncodingName>([
  ['model-small', 'cl100k_base'],
  ['model-medium', 'cl100k_base'],
  ['model-large', 'cl100k_base'],
]);

export function resolveEncodingForModel(model: string): EncodingName | null {
  return MODEL_TO_ENCODING.get(model) ?? null;
}

export function knownEncodings(): readonly EncodingName[] {
  return Array.from(new Set(MODEL_TO_ENCODING.values()));
}
