import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { migrate, openDb } from '../src/db.ts';
import { hashPassword, verifyPassword } from '../src/security/password.ts';
import { FailureLimiter } from '../src/security/rateLimit.ts';
import { redactText, redactValue } from '../src/security/redact.ts';

describe('redaction', () => {
  it('masks tokens, credentials in URLs, key=value secrets and private keys', () => {
    const out = redactText(
      [
        'Authorization: Bearer abc.def.ghi',
        'connect mongodb://admin:hunter2@db:27017/app',
        'password=hunter2 and API_KEY: "sk-live-123"',
        '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
        'Cookie: hlcc_session=abc',
      ].join('\n'),
    );
    for (const secret of ['abc.def.ghi', 'hunter2', 'sk-live-123', 'MIIB', 'hlcc_session=abc']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('db:27017/app'); // non-secret context survives
  });

  it('masks values under sensitive keys at any depth', () => {
    const out = redactValue({
      user: 'a',
      nested: { dbPassword: 'x', apiToken: 'y', list: [{ secret: 'z' }] },
    });
    expect(JSON.stringify(out)).not.toMatch(/"(x|y|z)"/);
    expect((out as { user: string }).user).toBe('a');
  });
});

describe('passwords', () => {
  it('verifies the right password only and never stores plaintext', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('FailureLimiter', () => {
  it('blocks after max failures and recovers when the window passes', () => {
    let t = 0;
    const l = new FailureLimiter(2, 1000, () => t);
    l.fail('k');
    l.fail('k');
    expect(l.allowed('k')).toBe(false);
    t = 1001;
    expect(l.allowed('k')).toBe(true);
  });
});

describe('migrations', () => {
  it('applies once, is idempotent, and rolls back a failing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hlcc-mig-'));
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const db = openDb(':memory:');
    expect(migrate(db, dir)).toEqual(['001_a.sql']);
    expect(migrate(db, dir)).toEqual([]);

    writeFileSync(
      join(dir, '002_bad.sql'),
      'CREATE TABLE b (id INTEGER); CREATE TABLE a (id INTEGER);',
    );
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n).toBe(1);
  });
});

describe('config', () => {
  it('has safe defaults and rejects invalid values', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('mock');
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.cookieSecure).toBe(false);
    expect(() => loadConfig({ HLCC_MODE: 'prod' })).toThrow();
    expect(() => loadConfig({ HLCC_SETUP_TOKEN: 'short' })).toThrow();
    expect(() => loadConfig({ HLCC_POLL_INTERVAL_MS: '5' })).toThrow();
  });
});
