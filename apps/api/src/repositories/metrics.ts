import type { DataSource, HistoryPoint, HostSample } from '@hlcc/shared';
import type { Db } from '../db.ts';

export function insertSample(db: Db, source: DataSource, ts: number, host: HostSample): void {
  db.prepare(
    'INSERT INTO metric_samples (ts, source, cpu_percent, mem_used, mem_total, payload) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ts, source, host.cpuPercent, host.memUsedBytes, host.memTotalBytes, JSON.stringify(host));
}

/** `ts` is when the sample was measured, so staleness survives an API restart. */
export function latestSample(
  db: Db,
  source: DataSource,
): { ts: number; host: HostSample } | undefined {
  const row = db
    .prepare('SELECT ts, payload FROM metric_samples WHERE source = ? ORDER BY ts DESC LIMIT 1')
    .get(source);
  return row
    ? { ts: Number(row.ts), host: JSON.parse(String(row.payload)) as HostSample }
    : undefined;
}

/** Returns at most `limit` points for the window, thinning evenly rather than loading everything. */
export function history(db: Db, source: DataSource, since: number, limit: number): HistoryPoint[] {
  const rows = db
    .prepare(
      'SELECT ts, cpu_percent, mem_used, mem_total FROM metric_samples WHERE source = ? AND ts >= ? ORDER BY ts',
    )
    .all(source, since);
  const step = Math.max(1, Math.ceil(rows.length / limit));
  return rows
    .filter((_, i) => i % step === 0)
    .map((r) => ({
      ts: Number(r.ts),
      cpuPercent: r.cpu_percent === null ? null : Number(r.cpu_percent),
      memUsedBytes: r.mem_used === null ? null : Number(r.mem_used),
      memTotalBytes: r.mem_total === null ? null : Number(r.mem_total),
    }));
}

export function pruneSamples(db: Db, before: number): void {
  db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(before);
}
