import type { TicketParams as DomainTicketParams } from '../../types/node.js';
import type {
  TicketParams as WireTicketParams,
  TicketExpirationParams as WireTicketExpirationParams,
} from './gen/livepeer/payments/v1/types.js';

export function bigintToBigEndianBytes(value: bigint): Buffer {
  if (value < 0n) throw new Error('bigintToBigEndianBytes: negative value');
  if (value === 0n) return Buffer.alloc(0);
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

export function bigEndianBytesToBigint(buf: Buffer | Uint8Array): bigint {
  if (buf.length === 0) return 0n;
  const hex = Buffer.from(buf).toString('hex');
  return BigInt('0x' + hex);
}

export function bytesToHex(buf: Buffer | Uint8Array): string {
  return '0x' + Buffer.from(buf).toString('hex');
}

export function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}

export function domainTicketParamsToWire(t: DomainTicketParams): WireTicketParams {
  const expirationParams: WireTicketExpirationParams = {
    creationRound: t.expirationParams.creationRound,
    creationRoundBlockHash: hexToBytes(t.expirationParams.creationRoundBlockHash),
  };
  return {
    recipient: hexToBytes(t.recipient),
    faceValue: bigintToBigEndianBytes(t.faceValueWei),
    winProb: hexToBigEndian(t.winProb),
    recipientRandHash: hexToBytes(t.recipientRandHash),
    seed: hexToBytes(t.seed),
    expirationBlock: bigintToBigEndianBytes(t.expirationBlock),
    expirationParams,
  };
}

export function wireTicketParamsToDomain(w: WireTicketParams): DomainTicketParams {
  const exp = w.expirationParams;
  return {
    recipient: bytesToHex(w.recipient),
    faceValueWei: bigEndianBytesToBigint(w.faceValue),
    winProb: bigEndianToHex(w.winProb),
    recipientRandHash: bytesToHex(w.recipientRandHash),
    seed: bytesToHex(w.seed),
    expirationBlock: bigEndianBytesToBigint(w.expirationBlock),
    expirationParams: {
      creationRound: exp?.creationRound ?? 0n,
      creationRoundBlockHash: exp ? bytesToHex(exp.creationRoundBlockHash) : '0x',
    },
  };
}

function hexToBigEndian(hex: string): Buffer {
  // Accept either a 0x-prefixed hex string or a base-10 integer string; treat
  // numeric-only input as decimal to keep compatibility with NodeClient wire
  // schemas that parse winProb as a decimal string.
  if (/^\d+$/.test(hex)) {
    return bigintToBigEndianBytes(BigInt(hex));
  }
  return hexToBytes(hex);
}

function bigEndianToHex(buf: Buffer | Uint8Array): string {
  return bytesToHex(buf);
}
