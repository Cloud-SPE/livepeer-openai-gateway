export type EncodingName = 'cl100k_base' | 'o200k_base';

export interface TokenizerProvider {
  count(encoding: EncodingName, text: string): number;
  preload(encodings: readonly EncodingName[]): void;
  close(): void;
}
