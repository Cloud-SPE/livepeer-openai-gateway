import { describe, expect, it } from 'vitest';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuitBreaker.js';

const config: CircuitBreakerConfig = {
  failureThreshold: 3,
  coolDownSeconds: 60,
};

describe('CircuitBreaker (stateful wrapper)', () => {
  it('lazily initializes state on first access', () => {
    const cb = new CircuitBreaker(config);
    const s = cb.state('node-1');
    expect(s.status).toBe('healthy');
    expect(s.consecutiveFailures).toBe(0);
  });

  it('onFailure → degraded → circuit_broken at threshold', () => {
    const cb = new CircuitBreaker(config);
    const now = new Date();
    cb.onFailure('node-1', now);
    cb.onFailure('node-1', now);
    expect(cb.state('node-1').status).toBe('degraded');
    const t = cb.onFailure('node-1', now);
    expect(t.kind).toBe('circuit_opened');
    expect(cb.state('node-1').status).toBe('circuit_broken');
  });

  it('onSuccess clears failures', () => {
    const cb = new CircuitBreaker(config);
    cb.onFailure('node-1', new Date());
    cb.onFailure('node-1', new Date());
    cb.onSuccess('node-1', new Date());
    expect(cb.state('node-1').status).toBe('healthy');
    expect(cb.state('node-1').consecutiveFailures).toBe(0);
  });

  it('currentExclusions reports circuit_broken nodes within cooldown', () => {
    const cb = new CircuitBreaker(config);
    const now = new Date('2026-04-26T12:00:00Z');
    cb.onFailure('a', now);
    cb.onFailure('a', now);
    cb.onFailure('a', now); // a is now circuit_broken
    cb.onFailure('b', now);
    expect(cb.currentExclusions(now).sort()).toEqual(['a']);
  });

  it('currentExclusions excludes a node whose cooldown has elapsed', () => {
    const cb = new CircuitBreaker(config);
    const opened = new Date('2026-04-26T12:00:00Z');
    cb.onFailure('a', opened);
    cb.onFailure('a', opened);
    cb.onFailure('a', opened);
    expect(cb.currentExclusions(opened)).toEqual(['a']);
    const after = new Date(opened.getTime() + (config.coolDownSeconds + 1) * 1000);
    expect(cb.currentExclusions(after)).toEqual([]);
  });

  it('shouldProbe returns true while healthy, false during cooldown, true after cooldown elapses', () => {
    const cb = new CircuitBreaker(config);
    const t0 = new Date('2026-04-26T12:00:00Z');
    expect(cb.shouldProbe('a', t0).probe).toBe(true);
    cb.onFailure('a', t0);
    cb.onFailure('a', t0);
    cb.onFailure('a', t0);
    expect(cb.shouldProbe('a', t0).probe).toBe(false);
    const after = new Date(t0.getTime() + (config.coolDownSeconds + 1) * 1000);
    const decision = cb.shouldProbe('a', after);
    expect(decision.probe).toBe(true);
    expect(decision.transition.kind).toBe('circuit_half_opened');
  });
});
