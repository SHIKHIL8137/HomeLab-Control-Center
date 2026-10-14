import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db.ts';
import { listAudit, recordAudit } from '../src/repositories/audit.ts';

const REAL = fileURLToPath(new URL('../../../migrations', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'hlcc-bak-'));

// The exact statement documented in docs/backup-and-recovery.md.
const backupTo = (db: DatabaseSync, file: string) =>
  db.exec(`VACUUM INTO '${file.split('\\').join('/')}'`);

describe('documented backup and restore', () => {
  it('takes an online backup that passes integrity checks and restores with its data', () => {
    const live = tmp();
    const db = openDb(live);
    migrate(db, REAL);
    recordAudit(
      db,
      {
        actor: 'admin',
        action: 'project.create',
        target: 'p1',
        outcome: 'success',
        ip: '203.0.113.7',
      },
      Date.now(),
    );

    const file = join(tmp(), 'backup-2026-01-01.db');
    backupTo(db, file); // taken while the live database stays open, as the doc describes
    db.close();

    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    check.close();

    const restored = tmp();
    copyFileSync(file, join(restored, 'hlcc.db'));
    const db2 = openDb(restored);
    expect(migrate(db2, REAL)).toEqual([]); // already current: nothing re-applied
    expect(listAudit(db2, 10).map((a) => a.target)).toContain('p1');
    db2.close();
  });

  it('upgrades an older backup by applying the migrations it predates', () => {
    const old = tmp();
    const older = tmp();
    copyFileSync(join(REAL, '001_init.sql'), join(older, '001_init.sql'));
    const db = openDb(old);
    migrate(db, older);
    const file = join(tmp(), 'old.db');
    backupTo(db, file);
    db.close();

    copyFileSync(file, join(old, 'restored.db'));
    const restoredDir = tmp();
    copyFileSync(file, join(restoredDir, 'hlcc.db'));
    const db2 = openDb(restoredDir);
    expect(migrate(db2, REAL).length).toBeGreaterThan(0);
    db2.close();
  });

  it('refuses to overwrite an existing backup file, so a repeat on one day is safe', () => {
    const db = openDb(tmp());
    migrate(db, REAL);
    const file = join(tmp(), 'backup.db');
    backupTo(db, file);
    expect(() => backupTo(db, file)).toThrow();
    expect(existsSync(file)).toBe(true);
    db.close();
  });

  it('detects a damaged backup before it is trusted', () => {
    const file = join(tmp(), 'bad.db');
    writeFileSync(file, 'this is not a database'.repeat(500));
    const bad = new DatabaseSync(file);
    expect(() => bad.prepare('PRAGMA integrity_check').get()).toThrow();
    bad.close();
  });
});
