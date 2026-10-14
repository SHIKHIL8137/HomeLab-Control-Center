import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { ContainerInfo, NetdataExtras } from '@hlcc/shared';
import type { Clock, Db } from '../db.ts';
import type { Provider } from '../providers/types.ts';
import { purgeExpiredSessions } from '../repositories/auth.ts';
import { insertEvents, pruneEvents } from '../repositories/events.ts';
import { insertSample, pruneSamples } from '../repositories/metrics.ts';
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

type SourceName = 'host' | 'docker' | 'netdata' | 'storage';
interface SourceError {
  at: number;
  message: string;
}

/**
 * Polls each integration independently: host, Docker and Netdata succeed or fail on their own,
 * and every failure is remembered with its message instead of being replaced by old data.
 */
export class Collector extends EventEmitter {
  containers: { at: number; items: ContainerInfo[]; warnings: string[] } | null = null;
  netdata: { at: number; data: NetdataExtras } | null = null;
  errors: Record<SourceName, SourceError | null> = {
    host: null,
    docker: null,
    netdata: null,
    storage: null,
  };
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly d: CollectorDeps;

  constructor(deps: CollectorDeps) {
    super();
    // One listener per open event stream (at most 20) plus a little headroom; the default of 10
    // would warn about a leak that is really just the permitted number of viewers.
    this.setMaxListeners(40);
    this.d = deps;
  }

  private fail(name: SourceName, err: unknown): void {
    const message = redactText(err instanceof Error ? err.message : String(err));
    if (this.errors[name]?.message !== message)
      this.d.log.warn({ source: name, message }, 'collection failed');
    this.errors[name] = { at: this.d.clock(), message };
  }

  async collectOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const { provider, db, clock } = this.d;
    try {
      const [host, docker, netdata] = await Promise.allSettled([
        withTimeout(provider.host(), 'host'),
        withTimeout(provider.docker(), 'docker'),
        provider.netdata ? withTimeout(provider.netdata(), 'netdata') : Promise.resolve(null),
      ]);
      const now = clock();

      // A database failure (full disk, locked file) is reported, never thrown out of a timer.
      let storageOk = true;
      const persist = (fn: () => void) => {
        try {
          fn();
        } catch (err) {
          storageOk = false;
          this.fail('storage', err);
        }
      };

      if (host.status === 'fulfilled') {
        persist(() =>
          insertSample(db, provider.source, Date.parse(host.value.collectedAt), host.value),
        );
        this.errors.host = null;
      } else this.fail('host', host.reason);

      if (docker.status === 'fulfilled') {
        this.containers = {
          at: now,
          items: docker.value.containers,
          warnings: docker.value.warnings,
        };
        persist(() => insertEvents(db, provider.source, docker.value.events));
        this.errors.docker = null;
      } else this.fail('docker', docker.reason);

      if (netdata.status === 'fulfilled') {
        if (netdata.value) this.netdata = { at: now, data: netdata.value };
        this.errors.netdata = null;
      } else this.fail('netdata', netdata.reason);

      persist(() => pruneSamples(db, now - this.d.retentionMs));
      persist(() => pruneEvents(db, now - this.d.retentionMs));
      persist(() => purgeExpiredSessions(db, now));
      if (storageOk) this.errors.storage = null;
    } finally {
      this.busy = false;
      this.emit('update');
    }
  }

  start(): void {
    void this.collectOnce();
    this.timer = setInterval(() => void this.collectOnce(), this.d.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

function withTimeout<T>(p: Promise<T>, name: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`${name} collection timed out after ${COLLECT_TIMEOUT_MS} ms`)),
      COLLECT_TIMEOUT_MS,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
