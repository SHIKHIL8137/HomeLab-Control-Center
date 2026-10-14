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

/**
 * Versioned, forward-only migrations: NNN_name.sql files applied once, each in its own transaction.
 * BEGIN IMMEDIATE takes the write lock before the "already applied?" check, so two processes
 * starting at once cannot both decide the same migration is pending. A failing file rolls back
 * completely and is not recorded, so the database never claims a schema it does not have.
 */
export function migrate(db: Db, dir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const ran: string[] = [];
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const done = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file);
      if (!done) {
        db.exec(readFileSync(join(dir, file), 'utf8'));
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          file,
          Date.now(),
        );
        ran.push(file);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return ran;
}
