import type { Clock } from '../db.ts';

/** Counts failures per key inside a sliding window; in memory, which is enough for one admin. */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  constructor(max: number, windowMs: number, clock: Clock) {
    this.max = max;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  private recent(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  allowed(key: string): boolean {
    return this.recent(key).length < this.max;
  }

  fail(key: string): void {
    this.hits.set(key, [...this.recent(key), this.clock()]);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    return list.length
      ? Math.max(1, Math.ceil((list[0]! + this.windowMs - this.clock()) / 1000))
      : 0;
  }
}
