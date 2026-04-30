import { describe, it, expect, beforeEach } from 'vitest';
import { createSession } from '../lib/session-storage.js';

beforeEach(() => {
  sessionStorage.clear();
});

describe('createSession', () => {
  it('isolates by namespace key', () => {
    const a = createSession('bridge.portal');
    const b = createSession('bridge.admin');

    a.set({ token: 'A' });
    b.set({ token: 'B' });

    expect(a.get()).toEqual({ token: 'A' });
    expect(b.get()).toEqual({ token: 'B' });
  });

  it('JSON-wraps and unwraps', () => {
    const s = createSession('bridge.test');
    s.set({ apiKey: 'sk-test', email: 'x@x' });
    expect(s.get()).toEqual({ apiKey: 'sk-test', email: 'x@x' });
  });

  it('clear() removes the value; has() reflects state', () => {
    const s = createSession('bridge.test');
    expect(s.has()).toBe(false);
    s.set({ a: 1 });
    expect(s.has()).toBe(true);
    s.clear();
    expect(s.has()).toBe(false);
    expect(s.get()).toBeNull();
  });

  it('returns null when stored value is corrupt', () => {
    sessionStorage.setItem('bridge.test.session', '{not json');
    const s = createSession('bridge.test');
    expect(s.get()).toBeNull();
  });
});
