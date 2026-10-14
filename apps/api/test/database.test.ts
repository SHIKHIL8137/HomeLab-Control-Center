import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db.ts';
import { insertCheck } from '../src/repositories/health.ts';
import { insertEvents } from '../src/repositories/events.ts';
import { insertSample } from '../src/repositories/metrics.ts';
import { getProject } from '../src/repositories/projects.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import { makeApp, signedIn } from './helpers.ts';

const REAL = fileURLToPath(new URL('../../../migrations', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `hlcc-${p}-`));

/** A migrations directory holding only the named real files, as an older release would have had. */
function only(...names: string[]): string {
  const dir = tmp('mig');
  for (const n of names) copyFileSync(join(REAL, n), join(dir, n));
  return dir;
}

describe('migrations', () => {
  it('builds the complete schema on a fresh database, in order, once', () => {
    const db = openDb(':memory:');
    const files = readdirSync(REAL)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(migrate(db, REAL)).toEqual(files);
    expect(migrate(db, REAL)).toEqual([]);
    const applied = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((r) => r.version);
    expect(applied).toEqual(files);
    expect(files).toEqual(['001_init.sql', '002_live_monitoring.sql', '003_audit_append_only.sql']);
  });

  it('upgrades a database created by the previous phase without losing anything', () => {
    const dir = tmp('db');
    const phase2 = openDb(dir);
    migrate(phase2, only('001_init.sql'));
    phase2
      .prepare(
        "INSERT INTO users (username, password_hash, created_at) VALUES ('admin', 'scrypt$x', 1)",
      )
      .run();
    phase2
      .prepare(
        `INSERT INTO projects (id, name, description, environment, desired_state, containers, capabilities, created_at, updated_at)
       VALUES ('legacy', 'Legacy', 'kept', 'production', 'running', '["a"]', '["monitor"]', 1, 1)`,
      )
      .run();
    phase2
      .prepare(
        "INSERT INTO audit_events (ts, actor, action, outcome) VALUES (1, 'admin', 'auth.login', 'success')",
      )
      .run();
    phase2
      .prepare(
        "INSERT INTO metric_samples (ts, source, cpu_percent, mem_used, mem_total, payload) VALUES (1, 'mock', 1, 2, 3, '{}')",
      )
      .run();
    phase2.close();

    // The next release opens the same file.
    const db = openDb(dir);
    expect(migrate(db, REAL)).toEqual(['002_live_monitoring.sql', '003_audit_append_only.sql']);
    const p = getProject(db, 'legacy')!;
    expect(p).toMatchObject({
      name: 'Legacy',
      description: 'kept',
      containers: ['a'],
      healthAllowPrivate: false,
      healthUrl: null,
    });
    expect(db.prepare('SELECT username FROM users').get()!.username).toBe('admin');
    expect(db.prepare('SELECT action FROM audit_events').get()!.action).toBe('auth.login');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get()!.n)).toBe(1);
    // New tables exist and the old audit rows are now protected.
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM container_events').get()!.n)).toBe(0);
    expect(() => db.exec('DELETE FROM audit_events')).toThrow(/append-only/);
    db.close();
  });

  it('defaults private-target authorization to off for projects that existed before it', () => {
    const db = openDb(':memory:');
    migrate(db, only('001_init.sql'));
    db.prepare(
      `INSERT INTO projects (id, name, environment, desired_state, containers, capabilities, created_at, updated_at, health_url)
       VALUES ('old', 'Old', 'production', 'running', '[]', '["monitor"]', 1, 1, 'https://example.com/')`,
    ).run();
    migrate(db, REAL);
    expect(getProject(db, 'old')!.healthAllowPrivate).toBe(false);
  });

  it('rolls a failing migration back completely and does not record it', () => {
    const dir = only('001_init.sql');
    const db = openDb(':memory:');
    migrate(db, dir);
    writeFileSync(
      join(dir, '002_bad.sql'),
      'CREATE TABLE half_done (id INTEGER); INSERT INTO nonexistent VALUES (1);',
    );
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").all()).toEqual([]);
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version = '002_bad.sql'").all(),
    ).toEqual([]);

    // Fixing the file lets the same migration run: the database never claimed it was done.
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE half_done (id INTEGER);');
    expect(migrate(db, dir)).toEqual(['002_bad.sql']);
  });

  it('stops at the first failure and leaves later migrations unapplied', () => {
    const dir = only('001_init.sql');
    writeFileSync(join(dir, '002_bad.sql'), 'THIS IS NOT SQL;');
    writeFileSync(join(dir, '003_later.sql'), 'CREATE TABLE later (id INTEGER);');
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'later'").all()).toEqual([]);
    expect(
      db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((r) => r.version),
    ).toEqual(['001_init.sql']);
  });

  it('is safe when two processes start at once against the same file', () => {
    const dir = tmp('race');
    const a = openDb(dir);
    const b = openDb(dir);
    expect(migrate(a, REAL)).toHaveLength(3);
    expect(migrate(b, REAL)).toEqual([]); // sees the work already done, does not re-run it
    a.close();
    b.close();
    const c = openDb(dir);
    expect(Number(c.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n)).toBe(3);
    c.close();
  });

  it('ignores files that are not numbered migrations', () => {
    const dir = only('001_init.sql');
    writeFileSync(join(dir, 'README.md'), 'notes');
    writeFileSync(join(dir, 'draft.sql'), 'DROP TABLE users;');
    writeFileSync(join(dir, '2_late.sql~'), 'DROP TABLE users;');
    const db = openDb(':memory:');
    expect(migrate(db, dir)).toEqual(['001_init.sql']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").all()).toHaveLength(1);
  });

  it('persists data across a restart', () => {
    const dir = tmp('persist');
    const first = openDb(dir);
    migrate(first, REAL);
    first
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('admin', 'h', 1)")
      .run();
    first.close();
    const second = openDb(dir);
    expect(migrate(second, REAL)).toEqual([]);
    expect(second.prepare('SELECT username FROM users').get()!.username).toBe('admin');
    second.close();
  });

  it('keeps foreign keys on, so deleting a user removes their sessions', () => {
    const db = openDb(tmp('fk'));
    migrate(db, REAL);
    db.prepare(
      "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'a', 'h', 1)",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES ('s', 1, 'c', 1, 9)",
    ).run();
    db.prepare('DELETE FROM users WHERE id = 1').run();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n)).toBe(0);
    expect(db.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
  });
});

describe('retention is bounded and touches only its own tables', () => {
  it('prunes old samples, events and health checks but nothing else', async () => {
    const h = makeApp({ env: { HLCC_RETENTION_HOURS: '1' } });
    const a = await signedIn(h);
    const now = h.time.t;
    const old = now - 3 * 3_600_000;
    const recent = now - 60_000;
    const mock = createMockProvider(() => now);
    const host = await mock.host();
    const project = getProject(h.db, 'devworkspace')!;
    const ok = {
      state: 'ok' as const,
      statusCode: 200,
      latencyMs: 1,
      error: null,
      targetClass: 'public' as const,
    };

    for (const ts of [old, recent]) {
      insertSample(h.db, 'mock', ts, host);
      insertEvents(h.db, 'mock', [{ ts, container: 'x', action: 'die', exitCode: 1 }]);
      insertCheck(h.db, 'mock', ts, project, ok);
    }
    const before = {
      users: h.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n,
      projects: h.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n,
      audit: h.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n,
    };

    await h.collector.collectOnce();

    const count = (t: string) =>
      Number(h.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ts < ?`).get(now - 3_600_000)!.n);
    expect(count('metric_samples')).toBe(0);
    expect(count('container_events')).toBe(0);
    // Health checks are pruned by the checker, not the collector.
    expect(count('health_checks')).toBe(1);
    await h.checker.runAll();
    expect(count('health_checks')).toBe(0);

    expect(
      Number(h.db.prepare('SELECT COUNT(*) AS n FROM metric_samples WHERE ts = ?').get(recent)!.n),
    ).toBe(1);
    expect(
      Number(
        h.db.prepare('SELECT COUNT(*) AS n FROM container_events WHERE ts = ?').get(recent)!.n,
      ),
    ).toBe(1);
    expect(
      Number(h.db.prepare('SELECT COUNT(*) AS n FROM health_checks WHERE ts = ?').get(recent)!.n),
    ).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(before.users);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n).toBe(before.projects);
    expect(
      Number(h.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n),
    ).toBeGreaterThanOrEqual(Number(before.audit));
    expect((await a.agent.get('/api/v1/overview')).status).toBe(200);
  });

  it('keeps history from growing without bound over many polls', async () => {
    const h = makeApp({ env: { HLCC_RETENTION_HOURS: '1' } });
    for (let i = 0; i < 400; i++) {
      h.time.t += 15_000; // 100 minutes of 15 s polls
      await h.collector.collectOnce();
    }
    const n = Number(h.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get()!.n);
    expect(n).toBeLessThanOrEqual(3600 / 15 + 2); // one hour of samples, give or take one
    expect(n).toBeGreaterThan(200);
  });

  it('removes expired sessions during collection', async () => {
    const h = makeApp();
    await signedIn(h);
    expect(Number(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n)).toBe(1);
    h.time.t += h.ctx.cfg.sessionTtlMs + 1000;
    await h.collector.collectOnce();
    expect(Number(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n)).toBe(0);
  });
});

describe('storage failures are reported, never thrown out of a timer', () => {
  it('survives a database error during collection and says so', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    h.db.exec('DROP TABLE metric_samples');
    await expect(h.collector.collectOnce()).resolves.toBeUndefined();
    expect(h.collector.errors.storage?.message).toBeTruthy();

    // The dashboard keeps answering: unreadable history reads as unavailable, with the reason shown.
    const res = await a.agent.get('/api/v1/overview');
    expect(res.status).toBe(200);
    expect(res.body.host).toMatchObject({ freshness: 'unavailable', data: null });
    expect(res.body.collectorErrors.storage.message).toBeTruthy();
    expect(res.body.docker.freshness).toBe('current'); // the other sources are unaffected
  });

  it('keeps the other sources working when only storage fails', async () => {
    const h = makeApp();
    h.db.exec('DROP TABLE container_events');
    await h.collector.collectOnce();
    expect(h.collector.containers).not.toBeNull(); // Docker data is still held in memory
    expect(h.collector.errors.docker).toBeNull();
    expect(h.collector.errors.storage).not.toBeNull();
  });

  it('clears the storage error once writes succeed again', async () => {
    const h = makeApp();
    h.db.exec('ALTER TABLE container_events RENAME TO container_events_away');
    await h.collector.collectOnce();
    expect(h.collector.errors.storage).not.toBeNull();
    h.db.exec('ALTER TABLE container_events_away RENAME TO container_events');
    await h.collector.collectOnce();
    expect(h.collector.errors.storage).toBeNull();
  });

  it('does not let a failing health-check table take the checker down', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    await a.agent
      .patch('/api/v1/projects/devworkspace')
      .set('x-csrf-token', a.csrf)
      .send({ healthUrl: 'https://example.com/' });
    await new Promise((r) => setTimeout(r, 50));
    h.db.exec('DROP TABLE health_checks');
    await expect(h.checker.runAll()).resolves.toBeUndefined();
    await expect(h.checker.runProject('devworkspace')).resolves.toBeUndefined();
  });

  it('exposes the storage problem to the dashboard', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    h.db.exec('ALTER TABLE container_events RENAME TO gone');
    await h.collector.collectOnce();
    const ov = (await a.agent.get('/api/v1/overview')).body;
    expect(ov.collectorErrors.storage.message).toBeTruthy();
    expect(ov.collectorErrors.host).toBeNull();
  });

  it('never leaks values from the failing statement into the error text', async () => {
    const h = makeApp();
    h.db.exec('DROP TABLE metric_samples');
    await h.collector.collectOnce();
    expect(h.collector.errors.storage!.message).not.toMatch(/INSERT|VALUES/i);
  });
});
