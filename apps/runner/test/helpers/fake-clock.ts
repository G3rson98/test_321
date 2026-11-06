import type { Clock } from '../../src/clock.js';

/** Reloj manual: `advance(ms)` resuelve los `sleep` vencidos en orden. */
export class FakeClock implements Clock {
  private t: number;
  private sleepers: Array<{ at: number; resolve: () => void }> = [];
  constructor(start = Date.parse('2026-11-06T12:00:00.000Z')) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const s = { at: this.t + ms, resolve };
      this.sleepers.push(s);
      signal?.addEventListener('abort', () => {
        this.sleepers = this.sleepers.filter((x) => x !== s);
        resolve();
      });
    });
  }
  get pendingSleeps(): number {
    return this.sleepers.length;
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = this.sleepers.filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      this.sleepers = this.sleepers.filter((s) => s !== due);
      due.resolve();
    }
    this.t = target;
    await flush();
  }
}

export async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}
