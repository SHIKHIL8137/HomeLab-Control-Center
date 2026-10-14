import { createHash } from 'node:crypto';
import {
  freshness,
  type DataSource,
  type HttpCheckState,
  type HttpCheckStatus,
  type Project,
} from '@hlcc/shared';
import type { Db } from '../db.ts';

export interface CheckRecord {
  state: Exclude<HttpCheckState, 'not_configured' | 'pending'>;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  targetClass: 'public' | 'private' | null;
}

/** Identifies "this URL, with this authorization", so a changed URL starts from a clean slate. */
export const targetFingerprint = (p: Pick<Project, 'healthUrl' | 'healthAllowPrivate'>): string =>
  createHash('sha256')
    .update(`${p.healthUrl ?? ''}|${p.healthAllowPrivate ? 1 : 0}`)
    .digest('hex')
    .slice(0, 16);

export function insertCheck(
  db: Db,
  source: DataSource,
  ts: number,
  project: Project,
  r: CheckRecord,
): void {
  db.prepare(
    `INSERT INTO health_checks (ts, source, project_id, target_fp, state, status_code, latency_ms, error, target_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    source,
    project.id,
    targetFingerprint(project),
    r.state,
    r.statusCode,
    r.latencyMs,
    r.error,
    r.targetClass,
  );
}

export function pruneChecks(db: Db, before: number): void {
  db.prepare('DELETE FROM health_checks WHERE ts < ?').run(before);
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const EMPTY: HttpCheckStatus = {
  state: 'not_configured',
  statusCode: null,
  latencyMs: null,
  consecutiveFailures: 0,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  error: null,
  targetClass: null,
  source: null,
  freshness: 'unavailable',
};

/** An unconfigured check is "not configured", never healthy and never silently absent. */
export function checkStatus(
  db: Db,
  project: Pick<Project, 'id' | 'healthUrl' | 'healthAllowPrivate'>,
  source: DataSource,
  now: number,
  intervalMs: number,
): HttpCheckStatus {
  if (!project.healthUrl) return EMPTY;
  const fp = targetFingerprint(project);
  const rows = db
    .prepare(
      `SELECT ts, state, status_code, latency_ms, error, target_class FROM health_checks
       WHERE project_id = ? AND source = ? AND target_fp = ? ORDER BY ts DESC LIMIT 50`,
    )
    .all(project.id, source, fp);
  if (rows.length === 0) return { ...EMPTY, state: 'pending', source };

  const latest = rows[0]!;
  let consecutiveFailures = 0;
  for (const r of rows) {
    if (r.state === 'ok') break;
    consecutiveFailures++;
  }
  const lastOf = (pred: (state: string) => boolean) => {
    const hit = rows.find((r) => pred(String(r.state)));
    return hit ? Number(hit.ts) : null;
  };
  const ts = Number(latest.ts);
  return {
    state: latest.state as HttpCheckStatus['state'],
    statusCode: latest.status_code === null ? null : Number(latest.status_code),
    latencyMs: latest.latency_ms === null ? null : Number(latest.latency_ms),
    consecutiveFailures,
    lastCheckedAt: iso(ts),
    lastSuccessAt: iso(lastOf((s) => s === 'ok')),
    lastFailureAt: iso(lastOf((s) => s !== 'ok')),
    error: latest.error === null ? null : String(latest.error),
    targetClass: (latest.target_class as 'public' | 'private' | null) ?? null,
    source,
    freshness: freshness(ts, now, intervalMs),
  };
}
