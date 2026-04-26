import { describe, expect, it } from 'vitest';
import { initialCircuitState, onFailure, onSuccess, shouldProbe } from './circuitBreaker.js';

const config = { failureThreshold: 3, coolDownSeconds: 30 };

describe('circuitBreaker state machine', () => {
  it('records a success without transition when already healthy', () => {
    const t0 = new Date(0);
    const r = onSuccess(initialCircuitState(), config, t0);
    expect(r.state.status).toBe('healthy');
    expect(r.state.consecutiveFailures).toBe(0);
    expect(r.transition.kind).toBe('none');
  });

  it('counts failures and flips to degraded before opening', () => {
    const t0 = new Date(0);
    const a = onFailure(initialCircuitState(), config, t0);
    expect(a.state.status).toBe('degraded');
    expect(a.state.consecutiveFailures).toBe(1);
    const b = onFailure(a.state, config, t0);
    expect(b.state.consecutiveFailures).toBe(2);
    expect(b.transition.kind).toBe('none');
  });

  it('opens the circuit when failures reach the threshold', () => {
    let s = initialCircuitState();
    let transition = 'none';
    for (let i = 0; i < config.failureThreshold; i++) {
      const r = onFailure(s, config, new Date(i));
      s = r.state;
      transition = r.transition.kind;
    }
    expect(s.status).toBe('circuit_broken');
    expect(transition).toBe('circuit_opened');
    expect(s.circuitOpenedAt).toBeInstanceOf(Date);
  });

  it('does not probe while cool-down is active', () => {
    let s = initialCircuitState();
    for (let i = 0; i < 3; i++) s = onFailure(s, config, new Date(i * 1000)).state;
    const decision = shouldProbe(s, config, new Date(10_000));
    expect(decision.probe).toBe(false);
  });

  it('transitions to half-open after cool-down and back to healthy on success', () => {
    let s = initialCircuitState();
    for (let i = 0; i < 3; i++) s = onFailure(s, config, new Date(i * 1000)).state;

    const probeAt = new Date(s.circuitOpenedAt!.getTime() + config.coolDownSeconds * 1000 + 1);
    const decision = shouldProbe(s, config, probeAt);
    expect(decision.probe).toBe(true);
    expect(decision.result.transition.kind).toBe('circuit_half_opened');
    expect(decision.result.state.halfOpenInFlight).toBe(true);

    const closed = onSuccess(decision.result.state, config, probeAt);
    expect(closed.state.status).toBe('healthy');
    expect(closed.transition.kind).toBe('circuit_closed');
  });

  it('re-opens the circuit if the half-open probe fails', () => {
    let s = initialCircuitState();
    for (let i = 0; i < 3; i++) s = onFailure(s, config, new Date(i * 1000)).state;
    const probeAt = new Date(s.circuitOpenedAt!.getTime() + 60_000);
    s = shouldProbe(s, config, probeAt).result.state;
    const reopened = onFailure(s, config, probeAt);
    expect(reopened.state.status).toBe('circuit_broken');
    expect(reopened.state.halfOpenInFlight).toBe(false);
    expect(reopened.state.circuitOpenedAt?.getTime()).toBe(probeAt.getTime());
  });

  it('shouldProbe passes through when not broken', () => {
    const decision = shouldProbe(initialCircuitState(), config, new Date(0));
    expect(decision.probe).toBe(true);
  });
});
