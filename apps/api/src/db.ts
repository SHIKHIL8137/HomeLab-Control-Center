import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = DatabaseSync;
export type Clock = () => number;

/** `:memory:` is for tests; otherwise the database lives in `<dataDir>/hlcc.db`. */
export function openDb(dataDir: string): Db {
  if (dataDir === ':memory:') return new DatabaseSync(':memory:');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'hlcc.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

/** Versioned, forward-only migrations: NNN_name.sql files applied once, each in a transaction. */
export function migrate(db: Db, dir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => String(r.version)),
  );
  const ran: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()) {
    if (applied.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
      db.exec('COMMIT');
      ran.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return ran;
}
