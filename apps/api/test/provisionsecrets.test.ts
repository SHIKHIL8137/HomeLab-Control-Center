import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('../../../scripts/provision-secrets.sh', import.meta.url),
).replace(/\\/g, '/');
const bash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = (p: string) => p.replace(/\\/g, '/');
const provision = (dir: string) => spawnSync('bash', [SCRIPT, posix(dir)], { encoding: 'utf8' });

describe.skipIf(!bash || isRoot)('provision-secrets.sh', () => {
  it('creates two independent, strong, unprinted secrets', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hlcc-prov-')), 'secrets');
    const r = provision(dir);
    expect(r.status, r.stderr).toBe(0);
    const a = readFileSync(join(dir, 'docker_proxy_token'), 'utf8');
    const b = readFileSync(join(dir, 'setup_token'), 'utf8');
    for (const v of [a, b]) {
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Set(v).size).toBeGreaterThanOrEqual(12);
      expect(r.stdout + r.stderr).not.toContain(v);
    }
    expect(a).not.toBe(b);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'docker_proxy_token')).mode & 0o777).toBe(0o400);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('is repeatable and never overwrites or reads an existing secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hlcc-prov-'));
    writeFileSync(join(dir, 'setup_token'), 'existing-value-that-must-survive-0123456789');
    const r = provision(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'setup_token'), 'utf8')).toBe(
      'existing-value-that-must-survive-0123456789',
    );
    expect(r.stdout).toContain('kept');
    expect(r.stdout + r.stderr).not.toContain('existing-value-that-must-survive');
    expect(existsSync(join(dir, 'docker_proxy_token'))).toBe(true);
    const again = provision(dir);
    expect(again.stdout.match(/kept/g)).toHaveLength(2);
  });

  it('refuses a directory inside a Git repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'hlcc-prov-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    for (const dir of [repo, join(repo, 'not', 'yet', 'made')]) {
      const r = provision(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/inside a Git repository/);
    }
    expect(existsSync(join(repo, 'docker_proxy_token'))).toBe(false);
  });

  it('refuses a relative path and a missing argument', () => {
    expect(spawnSync('bash', [SCRIPT, 'relative/dir'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync('bash', [SCRIPT], { encoding: 'utf8' }).status).not.toBe(0);
  });
});
