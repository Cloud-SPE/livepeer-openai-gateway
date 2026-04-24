import { describe, expect, it } from 'vitest';
import {
  bigEndianBytesToBigint,
  bigintToBigEndianBytes,
  bytesToHex,
  domainTicketParamsToWire,
  hexToBytes,
  wireTicketParamsToDomain,
} from './convert.js';

describe('convert: bigint ↔ big-endian bytes', () => {
  it('zero round-trips to empty buffer and back', () => {
    const buf = bigintToBigEndianBytes(0n);
    expect(buf.length).toBe(0);
    expect(bigEndianBytesToBigint(buf)).toBe(0n);
  });

  it('small values round-trip', () => {
    const values = [1n, 255n, 256n, 1000n, 1_000_000n, 10n ** 18n];
    for (const v of values) {
      expect(bigEndianBytesToBigint(bigintToBigEndianBytes(v))).toBe(v);
    }
  });

  it('very large (256-bit) values round-trip', () => {
    const v = (1n << 256n) - 1n;
    const buf = bigintToBigEndianBytes(v);
    expect(buf.length).toBe(32);
    expect(bigEndianBytesToBigint(buf)).toBe(v);
  });

  it('rejects negative bigints', () => {
    expect(() => bigintToBigEndianBytes(-1n)).toThrow();
  });
});

describe('convert: hex ↔ bytes', () => {
  it('round-trips 0x-prefixed hex', () => {
    const hex = '0x' + 'ab'.repeat(20);
    const buf = hexToBytes(hex);
    expect(bytesToHex(buf)).toBe(hex);
  });

  it('accepts unprefixed hex', () => {
    const buf = hexToBytes('ab'.repeat(20));
    expect(buf.length).toBe(20);
  });
});

describe('convert: TicketParams domain ↔ wire', () => {
  const domain = {
    recipient: '0x' + 'aa'.repeat(20),
    faceValueWei: 1_000_000n,
    winProb: '100',
    seed: '0x' + 'cd'.repeat(16),
    expirationBlock: 12345n,
    expirationParamsHash: '0x' + 'ef'.repeat(16),
  };

  it('domain → wire preserves recipient, faceValue, expirationBlock round-trip', () => {
    const wire = domainTicketParamsToWire(domain);
    expect(wire.recipient.length).toBe(20);
    expect(bigEndianBytesToBigint(wire.faceValue)).toBe(domain.faceValueWei);
    expect(bigEndianBytesToBigint(wire.expirationBlock)).toBe(domain.expirationBlock);
    expect(bytesToHex(wire.recipient)).toBe(domain.recipient.toLowerCase());
    expect(bytesToHex(wire.recipientRandHash)).toBe(domain.expirationParamsHash.toLowerCase());
  });

  it('wire → domain round-trips to same values', () => {
    const wire = domainTicketParamsToWire(domain);
    const back = wireTicketParamsToDomain(wire);
    expect(back.recipient).toBe(domain.recipient.toLowerCase());
    expect(back.faceValueWei).toBe(domain.faceValueWei);
    expect(back.expirationBlock).toBe(domain.expirationBlock);
    expect(back.expirationParamsHash).toBe(domain.expirationParamsHash.toLowerCase());
  });
});
