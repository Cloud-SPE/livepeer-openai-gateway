import { describe, expect, it } from 'vitest';
import { ManualScheduler, realScheduler } from './scheduler.js';

describe('ManualScheduler', () => {
  it('runs due tasks when time advances past their deadline', async () => {
    const s = new ManualScheduler();
    let count = 0;
    s.schedule(() => {
      count++;
    }, 100);
    await s.runDue();
    expect(count).toBe(0);
    s.advance(50);
    await s.runDue();
    expect(count).toBe(0);
    s.advance(100);
    await s.runDue();
    expect(count).toBe(1);
  });

  it('cancel prevents a task from running', async () => {
    const s = new ManualScheduler();
    const task = s.schedule(() => {
      throw new Error('should not run');
    }, 10);
    task.cancel();
    s.advance(100);
    await s.runDue();
  });

  it('awaits async callbacks', async () => {
    const s = new ManualScheduler();
    let resolved = false;
    s.schedule(async () => {
      await Promise.resolve();
      resolved = true;
    }, 0);
    await s.runDue();
    expect(resolved).toBe(true);
  });

  it('setNow pins wall clock for deterministic now()', () => {
    const s = new ManualScheduler();
    const t = new Date('2026-05-01T00:00:00Z');
    s.setNow(t);
    expect(s.now().getTime()).toBe(t.getTime());
  });
});

describe('realScheduler', () => {
  it('returns a cancelable task and a Date now()', () => {
    const s = realScheduler();
    const task = s.schedule(() => undefined, 10_000);
    expect(task.cancel).toBeInstanceOf(Function);
    task.cancel();
    expect(s.now()).toBeInstanceOf(Date);
  });
});
