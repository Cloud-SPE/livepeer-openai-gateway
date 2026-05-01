import { BinaryReader } from '@bufbuild/protobuf/wire';
import { describe, expect, it } from 'vitest';
import { __test__ } from './grpc.js';

describe('payer daemon gRPC serialization', () => {
  it('serializes capability and offering on CreatePayment requests', () => {
    const bytes = __test__.serializeCreatePaymentRequest({
      faceValue: new Uint8Array([0x01]),
      recipient: new Uint8Array(new Array(20).fill(0x11)),
      capability: 'openai:/v1/chat/completions',
      offering: 'Qwen3.6-27B',
    });

    const reader = new BinaryReader(bytes);
    const fields = new Map<number, string | Uint8Array>();
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
        case 2:
          fields.set(tag >>> 3, reader.bytes());
          break;
        case 3:
        case 4:
          fields.set(tag >>> 3, reader.string());
          break;
        default:
          reader.skip(tag & 7);
      }
    }

    expect(fields.get(3)).toBe('openai:/v1/chat/completions');
    expect(fields.get(4)).toBe('Qwen3.6-27B');
  });
});
