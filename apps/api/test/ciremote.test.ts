import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/ci-remote.sh', import.meta.url)).replace(
  /\\/g,
  '/',
);
const posix = (p: string) => p.replace(/\\/g, '/');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `hlcc-${p}-`));
const hasKeygen = spawnSync('ssh-keygen', ['-V']).error === undefined;

function hostKey(): string {
  const dir = tmp('hk');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', posix(join(dir, 'k'))]);
  return readFileSync(join(dir, 'k.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
}

function run(
  mode: string,
  o: { env?: Record<string, string>; sshOut?: string; sshStatus?: number } = {},
) {
  const repo = tmp('repo');
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'c');
  const sha = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const stubs = tmp('stub');
  const log = join(stubs, 'ssh.log');
  const stdinBytes = join(stubs, 'stdin.bytes');
  writeFileSync(
    join(stubs, 'ssh'),
    `#!/bin/sh\necho "$*" >> "${posix(log)}"\nwc -c >> "${posix(stdinBytes)}"\nprintf '%s\\n' "$STUB_SSH_OUT"\nexit \${STUB_SSH_STATUS:-0}\n`,
  );
  chmodSync(join(stubs, 'ssh'), 0o755);
  const sshDir = tmp('ssh');
  const r = spawnSync('bash', [SCRIPT, mode], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${posix(stubs)}:${process.env.PATH}`,
      SSH_DIR: posix(join(sshDir, 'dot-ssh')),
      DEPLOY_SSH_KEY: 'fake-private-key-material-not-real',
      HOMESERVER_HOST: '100.88.33.71',
      HOMESERVER_HOST_KEY: `100.88.33.71 ${hostKey()}`,
      DEPLOY_USER: 'shikhil',
      GITHUB_SHA: sha,
      STUB_SSH_OUT: o.sshOut ?? '',
      STUB_SSH_STATUS: String(o.sshStatus ?? 0),
      ...o.env,
    },
  });
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    r,
    out: `${r.stdout}${r.stderr}`,
    sshCalls: read(log).split('\n').filter(Boolean),
    stdin: read(stdinBytes),
    sha,
    tree,
    sshDir,
  };
}

describe.skipIf(!hasKeygen)('ci-remote.sh', () => {
  it('check sends only the word "check", with strict host-key checking and the pinned key file', () => {
    const x = run('check', { sshOut: 'configuration: ok\nno unfinished deploy marker' });
    expect(x.r.status, x.out).toBe(0);
    expect(x.sshCalls).toHaveLength(1);
    const call = x.sshCalls[0]!;
    expect(call).toMatch(/-o StrictHostKeyChecking=yes/);
    expect(call).toMatch(/-o BatchMode=yes/);
    expect(call).toMatch(/-o IdentitiesOnly=yes/);
    expect(call).toMatch(/-o UserKnownHostsFile=\S+known_hosts/);
    expect(call).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
    expect(call).toMatch(/shikhil@100\.88\.33\.71 check$/);
    expect(x.stdin.trim()).toBe('0'); // nothing is uploaded in check mode
  });

  it('deploy sends exactly "deploy <commit> <tree>" and a tar stream on stdin', () => {
    const x = run('deploy', { sshOut: 'ok' });
    expect(x.r.status, x.out).toBe(0);
    expect(x.sshCalls[0]).toMatch(
      new RegExp(`shikhil@100\\.88\\.33\\.71 deploy ${x.sha} ${x.tree}$`),
    );
    expect(Number(x.stdin.trim())).toBeGreaterThan(512); // a real archive was streamed
  });

  it('fails the job when the remote command fails', () => {
    expect(run('deploy', { sshStatus: 7 }).r.status).not.toBe(0);
  });

  it('check fails when the server says it is not ready', () => {
    expect(
      run('check', { sshOut: 'UNFINISHED DEPLOY MARKER PRESENT:\n  commit=abc' }).r.status,
    ).toBe(1);
    expect(
      run('check', { sshOut: 'configuration problems:\n  - env file is missing' }).r.status,
    ).toBe(1);
  });

  it('names missing secrets (never values) and does not connect', () => {
    const x = run('deploy', {
      env: { TS_UNUSED: '1', DEPLOY_SSH_KEY: '', HOMESERVER_HOST_KEY: '' },
    });
    expect(x.r.status).toBe(1);
    expect(x.out).toMatch(/Missing or empty Actions secrets: DEPLOY_SSH_KEY HOMESERVER_HOST_KEY/);
    expect(x.sshCalls).toEqual([]);
  });

  it('refuses root, odd user names, a bad mode, a wrong host-key entry and a stale checkout', () => {
    expect(run('deploy', { env: { DEPLOY_USER: 'root' } }).r.status).toBe(1);
    expect(run('deploy', { env: { DEPLOY_USER: 'a;b' } }).r.status).toBe(1);
    expect(run('rm -rf').r.status).toBe(2);
    const wrongKey = run('deploy', { env: { HOMESERVER_HOST_KEY: hostKey() } }); // no host in front
    expect(wrongKey.r.status).toBe(1);
    expect(wrongKey.sshCalls).toEqual([]);
    expect(run('deploy', { env: { GITHUB_SHA: 'f'.repeat(40) } }).r.status).toBe(1);
  });

  it('never prints the private key', () => {
    const x = run('check', { sshOut: 'configuration: ok' });
    expect(x.out).not.toContain('fake-private-key-material');
  });
});
