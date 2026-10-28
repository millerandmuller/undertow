import type { RunClock } from '../run.ts';

type ScheduledTask = {
  interval: number;
  nextAt: number;
  callback: () => Promise<void>;
};

export class SimulatedClock implements RunClock {
  private timeMs = 0;
  private tasks = new Set<ScheduledTask>();
  private beforeTick: (intervalMs: number) => Promise<void>;

  constructor(beforeTick: (intervalMs: number) => Promise<void> = async () => undefined) {
    this.beforeTick = beforeTick;
  }

  now(): number {
    return this.timeMs;
  }

  every(intervalMs: number, callback: () => Promise<void>): () => void {
    const task = {
      interval: intervalMs,
      nextAt: this.timeMs + intervalMs,
      callback,
    };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  }

  async advanceTo(targetMs: number): Promise<void> {
    while (true) {
      const next = [...this.tasks]
        .filter((task) => task.nextAt <= targetMs)
        .sort((left, right) => left.nextAt - right.nextAt)[0];
      if (!next) break;
      await this.beforeTick(next.interval);
      this.timeMs = next.nextAt;
      next.nextAt += next.interval;
      await next.callback();
    }
    this.timeMs = targetMs;
  }
}
