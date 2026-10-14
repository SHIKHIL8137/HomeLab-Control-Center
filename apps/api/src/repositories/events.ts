import type { ContainerEvent, DataSource, EventItem } from '@hlcc/shared';
import type { Db } from '../db.ts';

/** Duplicates (same millisecond, container and action) are ignored, so overlapping polls are safe. */
export function insertEvents(db: Db, source: DataSource, events: ContainerEvent[]): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO container_events (ts, source, container, action, exit_code) VALUES (?, ?, ?, ?, ?)',
  );
  for (const e of events) stmt.run(e.ts, source, e.container, e.action, e.exitCode);
}

export function listEvents(
  db: Db,
  source: DataSource,
  limit: number,
  beforeId?: number,
): EventItem[] {
  const rows = beforeId
    ? db
        .prepare(
          'SELECT * FROM container_events WHERE source = ? AND id < ? ORDER BY id DESC LIMIT ?',
        )
        .all(source, beforeId, limit)
    : db
        .prepare('SELECT * FROM container_events WHERE source = ? ORDER BY id DESC LIMIT ?')
        .all(source, limit);
  return rows.map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    container: String(r.container),
    action: String(r.action),
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
  }));
}

export function pruneEvents(db: Db, before: number): void {
  db.prepare('DELETE FROM container_events WHERE ts < ?').run(before);
}
