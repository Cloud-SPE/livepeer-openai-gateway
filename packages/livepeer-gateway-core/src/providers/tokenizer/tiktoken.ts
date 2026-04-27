import { get_encoding, type Tiktoken } from 'tiktoken';
import type { EncodingName, TokenizerProvider } from '../tokenizer.js';

export function createTiktokenProvider(): TokenizerProvider {
  const cache = new Map<EncodingName, Tiktoken>();

  function getEncoder(name: EncodingName): Tiktoken {
    let enc = cache.get(name);
    if (!enc) {
      enc = get_encoding(name);
      cache.set(name, enc);
    }
    return enc;
  }

  return {
    count(encoding, text) {
      if (text.length === 0) return 0;
      return getEncoder(encoding).encode(text).length;
    },
    preload(encodings) {
      for (const name of encodings) {
        getEncoder(name);
      }
    },
    close() {
      for (const enc of cache.values()) {
        enc.free();
      }
      cache.clear();
    },
  };
}
