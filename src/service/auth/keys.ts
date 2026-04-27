import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '@cloud-spe/bridge-core/repo/db.js';
import * as apiKeysRepo from '../../repo/apiKeys.js';

export type EnvPrefix = 'live' | 'test';

const KEY_RANDOM_BYTES = 32;
export const API_KEY_PATTERN = /^sk-(live|test)-[A-Za-z0-9_-]{43}$/;

export function generateApiKey(envPrefix: EnvPrefix): string {
  const random = randomBytes(KEY_RANDOM_BYTES).toString('base64url');
  return `sk-${envPrefix}-${random}`;
}

export function hashApiKey(pepper: string, plaintext: string): string {
  return createHmac('sha256', pepper).update(plaintext).digest('hex');
}

export function verifyApiKey(expectedHash: string, actualHash: string): boolean {
  if (expectedHash.length !== actualHash.length) return false;
  return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actualHash, 'hex'));
}

export interface IssueKeyInput {
  customerId: string;
  envPrefix: EnvPrefix;
  pepper: string;
  label?: string;
}

export interface IssueKeyResult {
  apiKeyId: string;
  plaintext: string;
}

export async function issueKey(db: Db, input: IssueKeyInput): Promise<IssueKeyResult> {
  const plaintext = generateApiKey(input.envPrefix);
  const hash = hashApiKey(input.pepper, plaintext);
  const row = await apiKeysRepo.insertApiKey(db, {
    customerId: input.customerId,
    hash,
    ...(input.label !== undefined ? { label: input.label } : {}),
  });
  return { apiKeyId: row.id, plaintext };
}

export async function revokeKey(db: Db, apiKeyId: string): Promise<void> {
  await apiKeysRepo.revoke(db, apiKeyId, new Date());
}
