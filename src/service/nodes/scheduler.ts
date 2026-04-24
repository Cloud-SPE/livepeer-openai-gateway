export interface Scheduler {
  schedule(cb: () => void | Promise<void>, delayMs: number): ScheduledTask;
  now(): Date;
}

export interface ScheduledTask {
  cancel(): void;
}

export function realScheduler(): Scheduler {
  return {
    schedule(cb, delayMs) {
      const handle = setTimeout(() => {
        void cb();
      }, delayMs);
      return { cancel: () => clearTimeout(handle) };
    },
    now() {
      return new Date();
    },
  };
}

export class ManualScheduler implements Scheduler {
  private nowMs = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { runAt: number; cb: () => void | Promise<void> }>();

  schedule(cb: () => void | Promise<void>, delayMs: number): ScheduledTask {
    const id = this.nextId++;
    this.tasks.set(id, { runAt: this.nowMs + delayMs, cb });
    return { cancel: () => this.tasks.delete(id) };
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  setNow(date: Date): void {
    this.nowMs = date.getTime();
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  async runDue(): Promise<void> {
    const due: Array<[number, { runAt: number; cb: () => void | Promise<void> }]> = [];
    for (const entry of this.tasks.entries()) {
      if (entry[1].runAt <= this.nowMs) due.push(entry);
    }
    due.sort((a, b) => a[1].runAt - b[1].runAt);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      await task.cb();
    }
  }
}
