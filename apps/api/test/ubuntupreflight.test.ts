import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/ubuntu-preflight.sh', import.meta.url));
const bash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const posix = (p: string) => p.replace(/\\/g, '/');

/** Puts recording stubs in front of PATH so nothing real can be changed, and returns what was called. */
function run(extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hlcc-ubu-'));
  const log = join(dir, 'calls.log');
  const stubs = [
    'docker',
    'systemctl',
    'tailscale',
    'sudo',
    'chmod',
    'chown',
    'rm',
    'mv',
    'cp',
    'cat',
    'curl',
    'ssh',
    'tee',
  ];
  for (const s of stubs) {
    const p = join(dir, s);
    writeFileSync(p, `#!/bin/sh\necho "${s} $*" >> "${posix(log)}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  const secret = join(dir, 'secret');
  writeFileSync(secret, 'MARKER-never-to-be-read-0123456789abcdef', { mode: 0o400 });
  const r = spawnSync('bash', [SCRIPT.replace(/\\/g, '/'), '--secret', posix(secret), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${posix(dir)}:${process.env.PATH}` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* nothing was called */
  }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

describe.skipIf(!bash)('ubuntu preflight script', () => {
  const r = run();

  it('finishes and says nothing was changed', () => {
    expect(r.status).toBe(0);
    expect(r.out).toContain('Nothing was changed');
  });

  it('only ever calls read-only commands', () => {
    const allowed = [
      /^docker --version$/,
      /^docker compose version$/,
      /^docker info --format /,
      /^docker network ls --format /,
      /^docker ps --format /,
      /^systemctl is-active (cloudflared|tailscaled)$/,
      /^tailscale serve status$/,
    ];
    for (const c of r.calls)
      expect(
        allowed.some((a) => a.test(c)),
        c,
      ).toBe(true);
  });

  it('never opens a secret, inspects a container or modifies anything', () => {
    const bad =
      /\b(inspect|exec|run|start|stop|restart|kill|rm|prune|chmod|chown|mv|cp|cat|tee|sudo|ssh|curl)\b/;
    expect(r.calls.filter((c) => bad.test(c))).toEqual([]);
    expect(r.out).not.toContain('MARKER-never-to-be-read');
  });

  it('reports a secret by metadata only', () => {
    expect(r.out).toMatch(/secret {2}owner=.* mode=\d+ size=\d+ bytes/);
  });

  it('rejects unknown options and a non-numeric port without running anything', () => {
    const bad = spawnSync('bash', [SCRIPT.replace(/\\/g, '/'), '--nope'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    const port = spawnSync('bash', [SCRIPT.replace(/\\/g, '/'), '--port', '80;ls'], {
      encoding: 'utf8',
    });
    expect(port.status).toBe(2);
  });
});
