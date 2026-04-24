import type { CircuitBreakerConfig } from '../../config/nodes.js';

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
