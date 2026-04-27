import type { CustomerTier } from '../../types/tier.js';
import type { NodeCapability } from '../../types/node.js';
import type {
  NodeRef,
  ServiceRegistryClient,
} from '../../providers/serviceRegistry.js';
import {
  RETRY_5XX,
  RETRY_CIRCUIT_OPEN,
  RETRY_QUOTE_EXPIRED,
  RETRY_TIMEOUT,
  type Recorder,
  type RetryAttempt,
  type RetryReason,
} from '../../providers/metrics/recorder.js';
import type { CircuitBreaker } from './circuitBreaker.js';
import { selectNode } from './router.js';

export type RetryDisposition = 'retry_next_node' | 'retry_same_node' | 'no_retry';

/** Map a numeric attempt count (1..3) onto the bounded RetryAttempt label. */
function attemptLabel(n: number): RetryAttempt {
  if (n <= 1) return '1';
  if (n === 2) return '2';
  return '3';
}

/** Best-effort retry-reason classifier. Inspects the error or HTTP status. */
export function classifyRetryReason(
  error: unknown,
  status: number | null,
): RetryReason {
  if (status !== null && status >= 500 && status < 600) return RETRY_5XX;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const lower = msg.toLowerCase();
  if (lower.includes('quote') && (lower.includes('expir') || lower.includes('refresh'))) {
    return RETRY_QUOTE_EXPIRED;
  }
  if (lower.includes('circuit')) return RETRY_CIRCUIT_OPEN;
  return RETRY_TIMEOUT;
}

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
  serviceRegistry: ServiceRegistryClient;
  circuitBreaker: CircuitBreaker;
  model: string;
  tier: CustomerTier;
  capability: NodeCapability;
  maxAttempts: number;
  rng?: () => number;
  /** Optional recorder. Each retry attempt past the first emits incNodeRetry. */
  recorder?: Recorder;
}

export interface AttemptContext {
  attempt: number;
  node: NodeRef;
  previousNodeIds: string[];
}

export async function runWithRetry<T>(
  deps: RunWithRetryDeps,
  fn: (ctx: AttemptContext) => Promise<AttemptResult<T>>,
): Promise<AttemptResult<T>> {
  const previousNodeIds: string[] = [];
  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    const node = await selectNode(
      {
        serviceRegistry: deps.serviceRegistry,
        circuitBreaker: deps.circuitBreaker,
        ...(deps.rng ? { rng: deps.rng } : {}),
      },
      { capability: deps.capability, model: deps.model, tier: deps.tier },
    );
    const result = await fn({ attempt, node, previousNodeIds });
    if (result.ok) return result;
    lastFailure = result;
    if (result.firstTokenDelivered) return result;
    if (result.disposition === 'no_retry') return result;
    if (attempt === deps.maxAttempts) return result;
    if (result.disposition === 'retry_next_node') {
      previousNodeIds.push(node.id);
      // Tell the circuit breaker so the next selectNode excludes this node.
      deps.circuitBreaker.onFailure(node.id, new Date());
    }
    if (deps.recorder) {
      const reason = classifyRetryReason(result.error, null);
      deps.recorder.incNodeRetry(reason, attemptLabel(attempt));
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
