import type { CircuitBreakerConfig } from '../../config/routing.js';

export type { CircuitBreakerConfig };

export type CircuitStatus = 'healthy' | 'degraded' | 'circuit_broken';

export interface CircuitState {
  status: CircuitStatus;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  circuitOpenedAt: Date | null;
  halfOpenInFlight: boolean;
}

export function initialCircuitState(): CircuitState {
  return {
    status: 'healthy',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    circuitOpenedAt: null,
    halfOpenInFlight: false,
  };
}

export type CircuitTransition =
  | { kind: 'none' }
  | { kind: 'circuit_opened' }
  | { kind: 'circuit_half_opened' }
  | { kind: 'circuit_closed' };

export interface CircuitResult {
  state: CircuitState;
  transition: CircuitTransition;
}

export function onSuccess(
  state: CircuitState,
  _config: CircuitBreakerConfig,
  now: Date,
): CircuitResult {
  if (state.status === 'circuit_broken' && state.halfOpenInFlight) {
    return {
      state: {
        status: 'healthy',
        consecutiveFailures: 0,
        lastSuccessAt: now,
        lastFailureAt: state.lastFailureAt,
        circuitOpenedAt: null,
        halfOpenInFlight: false,
      },
      transition: { kind: 'circuit_closed' },
    };
  }

  return {
    state: {
      status: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: now,
      lastFailureAt: state.lastFailureAt,
      circuitOpenedAt: null,
      halfOpenInFlight: false,
    },
    transition: { kind: 'none' },
  };
}

export function onFailure(
  state: CircuitState,
  config: CircuitBreakerConfig,
  now: Date,
): CircuitResult {
  if (state.status === 'circuit_broken' && state.halfOpenInFlight) {
    return {
      state: {
        ...state,
        consecutiveFailures: state.consecutiveFailures + 1,
        lastFailureAt: now,
        circuitOpenedAt: now,
        halfOpenInFlight: false,
      },
      transition: { kind: 'none' },
    };
  }

  const nextFailures = state.consecutiveFailures + 1;

  if (nextFailures >= config.failureThreshold && state.status !== 'circuit_broken') {
    return {
      state: {
        status: 'circuit_broken',
        consecutiveFailures: nextFailures,
        lastSuccessAt: state.lastSuccessAt,
        lastFailureAt: now,
        circuitOpenedAt: now,
        halfOpenInFlight: false,
      },
      transition: { kind: 'circuit_opened' },
    };
  }

  return {
    state: {
      status: nextFailures > 0 ? 'degraded' : state.status,
      consecutiveFailures: nextFailures,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: now,
      circuitOpenedAt: state.circuitOpenedAt,
      halfOpenInFlight: false,
    },
    transition: { kind: 'none' },
  };
}

export function shouldProbe(
  state: CircuitState,
  config: CircuitBreakerConfig,
  now: Date,
): { probe: boolean; result: CircuitResult } {
  if (state.status !== 'circuit_broken') {
    return { probe: true, result: { state, transition: { kind: 'none' } } };
  }
  if (!state.circuitOpenedAt) {
    return { probe: true, result: { state, transition: { kind: 'none' } } };
  }
  const elapsedMs = now.getTime() - state.circuitOpenedAt.getTime();
  if (elapsedMs < config.coolDownSeconds * 1000) {
    return { probe: false, result: { state, transition: { kind: 'none' } } };
  }
  if (state.halfOpenInFlight) {
    return { probe: false, result: { state, transition: { kind: 'none' } } };
  }
  return {
    probe: true,
    result: {
      state: { ...state, halfOpenInFlight: true },
      transition: { kind: 'circuit_half_opened' },
    },
  };
}

/**
 * Stateful circuit-breaker keyed by `nodeId`. Wraps the pure-policy
 * functions above and owns the per-node state map. Used by the
 * dispatchers (via `currentExclusions`) and by `quoteRefresher` (via
 * `onSuccess`/`onFailure`/`shouldProbe`).
 *
 * Per exec-plan 0025.
 */
export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  constructor(private readonly config: CircuitBreakerConfig) {}

  /** Lazily-initialized state for a node. */
  state(nodeId: string): CircuitState {
    let s = this.states.get(nodeId);
    if (!s) {
      s = initialCircuitState();
      this.states.set(nodeId, s);
    }
    return s;
  }

  onSuccess(nodeId: string, now: Date): CircuitTransition {
    const result = onSuccess(this.state(nodeId), this.config, now);
    this.states.set(nodeId, result.state);
    return result.transition;
  }

  onFailure(nodeId: string, now: Date): CircuitTransition {
    const result = onFailure(this.state(nodeId), this.config, now);
    this.states.set(nodeId, result.state);
    return result.transition;
  }

  shouldProbe(nodeId: string, now: Date): { probe: boolean; transition: CircuitTransition } {
    const result = shouldProbe(this.state(nodeId), this.config, now);
    if (result.result.state !== this.states.get(nodeId)) {
      this.states.set(nodeId, result.result.state);
    }
    return { probe: result.probe, transition: result.result.transition };
  }

  /**
   * Node ids that should currently be excluded from selection: status
   * is `circuit_broken` AND the cool-down window hasn't elapsed.
   * Dispatchers pass this set into `serviceRegistry.select({excludeIds})`
   * (when daemon-side selection lands in stage 2's task 18.5) — option
   * a2 from the plan: bridge-local exclusion + retry on full exclusion.
   */
  currentExclusions(now: Date): string[] {
    const out: string[] = [];
    for (const [id, s] of this.states) {
      if (s.status !== 'circuit_broken') continue;
      if (!s.circuitOpenedAt) continue;
      const elapsedMs = now.getTime() - s.circuitOpenedAt.getTime();
      if (elapsedMs < this.config.coolDownSeconds * 1000) {
        out.push(id);
      }
    }
    return out;
  }

  /** Inspection helper for tests. */
  snapshot(): Map<string, CircuitState> {
    return new Map(this.states);
  }
}
