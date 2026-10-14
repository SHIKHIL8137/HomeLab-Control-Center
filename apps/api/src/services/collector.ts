import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { ContainerInfo } from '@hlcc/shared';
import type { Clock, Db } from '../db.ts';
import type { Provider } from '../providers/types.ts';
import { insertSample, pruneSamples } from '../repositories/metrics.ts';
import { purgeExpiredSessions } from '../repositories/auth.ts';
import { redactText } from '../security/redact.ts';

const COLLECT_TIMEOUT_MS = 10_000;

export interface CollectorDeps {
  provider: Provider;
  db: Db;
  clock: Clock;
  pollIntervalMs: number;
  retentionMs: number;
  log: Logger;
}

/** Polls the provider, persists host samples and keeps the latest container snapshot in memory. */
export class Collector extends EventEmitter {
  containers: { at: number; items: ContainerInfo[] } | null = null;
  lastError: { at: number; message: string } | null = null;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly deps: CollectorDeps;

  constructor(deps: CollectorDeps) {
    super();
    this.deps = deps;
  }

  async collectOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const { provider, db, clock, log } = this.deps;
    try {
      const [host, items] = await withTimeout(
        Promise.all([provider.host(), provider.containers()]),
        COLLECT_TIMEOUT_MS,
      );
      const now = clock();
      insertSample(db, provider.source, Date.parse(host.collectedAt), host);
      this.containers = { at: now, items };
      this.lastError = null;
      pruneSamples(db, now - this.deps.retentionMs);
      purgeExpiredSessions(db, now);
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err));
      if (this.lastError?.message !== message) log.warn({ message }, 'collection failed');
      this.lastError = { at: clock(), message };
    } finally {
      this.busy = false;
      this.emit('update');
    }
  }

  start(): void {
    void this.collectOnce();
    this.timer = setInterval(() => void this.collectOnce(), this.deps.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`collection timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
