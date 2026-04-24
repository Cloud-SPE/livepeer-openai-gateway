import type { NodeBook, NodeEntry } from '../nodes/nodebook.js';
import type { CustomerTier } from '../../types/customer.js';
import { pickNode } from './router.js';

export type RetryDisposition = 'retry_next_node' | 'retry_same_node' | 'no_retry';

export interface AttemptOutcome<T> {
  ok: true;
  value: T;
}

export interface AttemptFailure {
  ok: false;
  error: unknown;
  disposition: RetryDisposition;
  firstTokenDelivered: boolean;
}

export type AttemptResult<T> = AttemptOutcome<T> | AttemptFailure;

export interface RunWithRetryDeps {
  nodeBook: NodeBook;
  model: string;
  tier: CustomerTier;
  maxAttempts: number;
  rng?: () => number;
}

export interface AttemptContext {
  attempt: number;
  node: NodeEntry;
  previousNodeIds: string[];
}

export async function runWithRetry<T>(
  deps: RunWithRetryDeps,
  fn: (ctx: AttemptContext) => Promise<AttemptResult<T>>,
): Promise<AttemptResult<T>> {
  const previousNodeIds: string[] = [];
  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    const node = pickNode(
      { nodeBook: deps.nodeBook, ...(deps.rng ? { rng: deps.rng } : {}) },
      deps.model,
      deps.tier,
    );
    const result = await fn({ attempt, node, previousNodeIds });
    if (result.ok) return result;
    lastFailure = result;
    if (result.firstTokenDelivered) return result;
    if (result.disposition === 'no_retry') return result;
    if (attempt === deps.maxAttempts) return result;
    if (result.disposition === 'retry_next_node') {
      previousNodeIds.push(node.config.id);
    }
  }

  return (
    lastFailure ?? {
      ok: false as const,
      error: new Error('runWithRetry: exhausted with no attempt made'),
      disposition: 'no_retry',
      firstTokenDelivered: false,
    }
  );
}

export function classifyNodeError(
  status: number | null,
  firstTokenDelivered: boolean,
): RetryDisposition {
  if (firstTokenDelivered) return 'no_retry';
  if (status === null) return 'retry_next_node';
  if (status >= 500 && status < 600) return 'retry_next_node';
  return 'no_retry';
}
