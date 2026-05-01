/* v8 ignore file */

export function bigintToBigEndianBytes(value: bigint): Buffer {
  if (value < 0n) throw new Error('bigintToBigEndianBytes: negative value');
  if (value === 0n) return Buffer.alloc(0);
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

export function bigEndianBytesToBigint(buf: Buffer | Uint8Array): bigint {
  if (buf.length === 0) return 0n;
  return BigInt(`0x${Buffer.from(buf).toString('hex')}`);
}

export function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}
