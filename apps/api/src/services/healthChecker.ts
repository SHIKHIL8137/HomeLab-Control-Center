import type { Logger } from 'pino';
import type { DataSource, Project } from '@hlcc/shared';
import type { Clock, Db } from '../db.ts';
import { insertCheck, pruneChecks, type CheckRecord } from '../repositories/health.ts';
import { getProject, listProjects } from '../repositories/projects.ts';
import { redactText } from '../security/redact.ts';
import { guardedGet, validateTarget } from '../security/ssrf.ts';
import { mapLimit } from '../util.ts';

export type Fetcher = (req: { url: string; allowPrivate: boolean }) => Promise<CheckRecord>;

/** Real network checks, always through the SSRF guard. */
export function liveFetcher(resolver?: Parameters<typeof guardedGet>[1]['resolver']): Fetcher {
  return async ({ url, allowPrivate }) => {
    const r = await guardedGet(url, {
      allowPrivate,
      timeoutMs: 5000,
      overallMs: 10_000,
      maxRedirects: 3,
      ...(resolver ? { resolver } : {}),
    });
    if (r.failure === 'blocked' || r.failure === 'invalid_url') {
      return {
        state: 'blocked',
        statusCode: null,
        latencyMs: null,
        error: redactText(r.message ?? 'blocked'),
        targetClass: null,
      };
    }
    if (r.ok)
      return {
        state: 'ok',
        statusCode: r.statusCode,
        latencyMs: r.latencyMs,
        error: null,
        targetClass: r.targetClass,
      };
    return {
      state: 'failed',
      statusCode: r.statusCode,
      latencyMs: r.latencyMs,
      error: redactText(r.failure ? `${r.failure}: ${r.message}` : `HTTP ${r.statusCode}`).slice(
        0,
        200,
      ),
      targetClass: r.targetClass,
    };
  };
}

/** Deterministic stand-in for mock mode: no network traffic, still honours the target policy. */
export function mockFetcher(): Fetcher {
  return async ({ url, allowPrivate }) => {
    const v = validateTarget(url, allowPrivate);
    if (!v.ok)
      return {
        state: 'blocked',
        statusCode: null,
        latencyMs: null,
        error: v.message,
        targetClass: null,
      };
    const host = new URL(url).hostname;
    const isPrivate =
      /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === 'localhost';
    const targetClass = isPrivate ? 'private' : 'public';
    if (host.includes('fail'))
      return { state: 'failed', statusCode: 503, latencyMs: 40, error: 'HTTP 503', targetClass };
    return {
      state: 'ok',
      statusCode: 200,
      latencyMs: 30 + (host.length % 50),
      error: null,
      targetClass,
    };
  };
}

export interface HealthCheckerDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  source: DataSource;
  fetcher: Fetcher;
  intervalMs: number;
  retentionMs: number;
  concurrency: number;
  notify: () => void;
}

export class HealthChecker {
  private readonly d: HealthCheckerDeps;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(deps: HealthCheckerDeps) {
    this.d = deps;
  }

  private async check(p: Project): Promise<void> {
    if (!p.healthUrl) return;
    let record: CheckRecord;
    try {
      record = await this.d.fetcher({ url: p.healthUrl, allowPrivate: p.healthAllowPrivate });
    } catch (err) {
      this.d.log.warn({ project: p.id, err: redactText(String(err)) }, 'health check crashed');
      record = {
        state: 'failed',
        statusCode: null,
        latencyMs: null,
        error: 'check failed to run',
        targetClass: null,
      };
    }
    try {
      insertCheck(this.d.db, this.d.source, this.d.clock(), p, record);
    } catch (err) {
      this.d.log.error(
        { project: p.id, err: redactText(String(err)) },
        'could not store a health check',
      );
    }
  }

  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const projects = listProjects(this.d.db).filter((p) => p.healthUrl);
      await mapLimit(projects, this.d.concurrency, (p) => this.check(p));
      try {
        pruneChecks(this.d.db, this.d.clock() - this.d.retentionMs);
      } catch (err) {
        this.d.log.error({ err: redactText(String(err)) }, 'could not prune health checks');
      }
    } finally {
      this.running = false;
      this.d.notify();
    }
  }

  /** Used right after a URL or its authorization changes, so the result does not wait a full interval. */
  async runProject(id: string): Promise<void> {
    try {
      const p = getProject(this.d.db, id);
      if (p) await this.check(p);
    } catch (err) {
      this.d.log.error({ project: id, err: redactText(String(err)) }, 'health check could not run');
    }
    this.d.notify();
  }

  start(): void {
    void this.runAll();
    this.timer = setInterval(() => void this.runAll(), this.d.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
