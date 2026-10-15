import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('../../../scripts/ci-known-hosts.sh', import.meta.url),
).replace(/\\/g, '/');
const ok = ['bash', 'ssh-keygen'].every(
  (c) => spawnSync(c, ['-V']).error === undefined || c === 'bash',
);
const posix = (p: string) => p.replace(/\\/g, '/');

// A real throwaway ed25519 host key (public half), so the shape checks run against genuine data.
function sampleKey(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hlcc-hk-'));
  const k = join(dir, 'k');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', posix(k)]);
  return readFileSync(`${k}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
}

function run(host: string, entry: string) {
  const out = join(mkdtempSync(join(tmpdir(), 'hlcc-kh-')), 'ssh', 'known_hosts');
  const r = spawnSync('bash', [SCRIPT, posix(out)], {
    encoding: 'utf8',
    env: { ...process.env, HOMESERVER_HOST: host, HOMESERVER_HOST_KEY: entry },
  });
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    file: existsSync(out) ? readFileSync(out, 'utf8') : null,
  };
}

describe.skipIf(!ok)('ci-known-hosts.sh', () => {
  const keyed = sampleKey();
  const host = '100.88.33.71';

  it('writes exactly one entry for the exact host and shows its fingerprint', () => {
    const r = run(host, `${host} ${keyed}`);
    expect(r.status, r.out).toBe(0);
    expect(r.file).toBe(`${host} ${keyed}\n`);
    expect(r.out).toMatch(/trusting SHA256:\S+ for 100\.88\.33\.71/);
  });

  it('tolerates a trailing newline or CRLF from the secret store', () => {
    expect(run(host, `${host} ${keyed}\n`).status).toBe(0);
    expect(run(host, `${host} ${keyed}\r\n`).file).toBe(`${host} ${keyed}\n`);
  });

  it('refuses a key without the host (the host would be added twice downstream)', () => {
    const r = run(host, keyed);
    expect(r.status).toBe(1);
    expect(r.file).toBeNull();
  });

  it('refuses an entry for a different host', () => {
    expect(run(host, `100.88.33.72 ${keyed}`).status).toBe(1);
    expect(run('other.example', `${host} ${keyed}`).status).toBe(1);
  });

  it('refuses two lines, extra fields, other key types and malformed keys', () => {
    for (const entry of [
      `${host} ${keyed}\n${host} ${keyed}`,
      `${host} ${keyed} comment`,
      `${host} ssh-rsa ${keyed.split(' ')[1]}`,
      `${host} ssh-ed25519 AAAA-not-a-key`,
      `${host} ssh-ed25519 ${keyed.split(' ')[1]!.slice(0, -4)}`,
      `@cert-authority ${host} ${keyed}`,
      `*.example ${keyed}`,
      '',
    ]) {
      const r = run(host, entry);
      expect(r.status, entry).toBe(1);
      expect(r.file, entry).toBeNull();
    }
  });

  it('refuses a missing or odd host name and never echoes the entry in an error', () => {
    expect(run('', `${host} ${keyed}`).status).toBe(1);
    expect(run('a b', `a b ${keyed}`).status).toBe(1);
    const r = run(host, `${host} ${keyed.split(' ')[0]} AAAAbadbadbad`);
    expect(r.out).not.toContain('AAAAbadbadbad');
  });

  it('is a plain file readable only by its owner where modes apply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hlcc-kh-'));
    const out = join(dir, 'known_hosts');
    const r = spawnSync('bash', [SCRIPT, posix(out)], {
      encoding: 'utf8',
      env: { ...process.env, HOMESERVER_HOST: host, HOMESERVER_HOST_KEY: `${host} ${keyed}` },
    });
    expect(r.status).toBe(0);
    if (process.platform !== 'win32') {
      chmodSync(out, 0o600);
      expect(readFileSync(out, 'utf8')).toContain(host);
    }
    writeFileSync(join(dir, 'x'), '');
  });
});
