import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCANNER = join(ROOT, 'scripts', 'check-secrets.mjs');

/** Runs the real scanner inside a throwaway git repository holding exactly the given files. */
function scan(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'hlcc-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const r = spawnSync(process.execPath, [SCANNER], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('secret scanner: YAML credentials', () => {
  it('rejects a fixed value on a credential-named key', () => {
    for (const line of [
      'HLCC_SETUP_TOKEN: local-demo-setup-token',
      '  HLCC_SETUP_TOKEN: abcdefghijklmnop',
      '- PROXY_TOKEN: hunter2hunter2',
      'db_password: s3cr3t-value',
      'API_KEY: "sk-live-abcdef"',
      "  SOME_SECRET: 'plain value'",
      'POSTGRES_PASSWORD: postgres',
    ]) {
      const r = scan({ 'compose.yaml': `services:\n  a:\n    environment:\n      ${line}\n` });
      expect(r.status, line).toBe(1);
      expect(r.out, line).toMatch(/compose\.yaml:\d+: .* has a fixed value/);
      expect(r.out).not.toContain(
        line.split(':').slice(1).join(':').trim().replace(/["']/g, '') || 'zzz-never',
      );
    }
  });

  it('accepts references, secret files, empty values and secret names without values', () => {
    const ok = [
      'HLCC_SETUP_TOKEN: ${HLCC_SETUP_TOKEN}',
      'HLCC_SETUP_TOKEN: ${HLCC_SETUP_TOKEN:-}',
      "HLCC_SETUP_TOKEN: '${HLCC_SETUP_TOKEN}'",
      'HLCC_DOCKER_TOKEN_FILE: /run/secrets/docker_proxy_token',
      'PROXY_TOKEN_FILE: /run/secrets/docker_proxy_token',
      'GH_TOKEN: ${{ secrets.WEBSITE_DISPATCH_TOKEN }}',
      "TOKEN: ''",
      'TOKEN:',
      'secrets: [docker_proxy_token]',
      'docker_proxy_token:',
      '  file: ${HLCC_SECRET_DOCKER_TOKEN_FILE}',
    ];
    const r = scan({
      'compose.yaml': `services:\n  a:\n    environment:\n${ok.map((l) => `      ${l}`).join('\n')}\n`,
    });
    expect(r.out).not.toMatch(/has a fixed value/);
  });

  it('only applies the YAML rule to YAML files', () => {
    const r = scan({ 'notes.md': 'HLCC_SETUP_TOKEN: example-in-docs-abcdef\n' });
    expect(r.status).toBe(0);
  });

  it('reports the file and line, never the value', () => {
    const r = scan({ 'deploy/x.yml': 'a: 1\nPASSWORD: super-secret-value-123\n' });
    expect(r.out).toContain('deploy/x.yml:2');
    expect(r.out).not.toContain('super-secret-value-123');
  });
});

describe('secret scanner: other rules', () => {
  it('rejects secret-bearing file types and private keys', () => {
    expect(scan({ '.env': 'A=b\n' }).status).toBe(1);
    expect(scan({ 'server.pem': 'x' }).status).toBe(1);
    expect(scan({ id_ed25519: 'x' }).status).toBe(1);
    expect(scan({ 'data.db': 'x' }).status).toBe(1);
    expect(
      scan({ 'notes.txt': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }).status,
    ).toBe(1);
  });

  it('allows the example environment file', () => {
    expect(scan({ '.env.example': 'HLCC_MODE=mock\n# HLCC_SETUP_TOKEN=\n' }).status).toBe(0);
  });

  it('rejects well-known token shapes and credentials inside URLs', () => {
    expect(scan({ 'a.txt': `token ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}\n` }).status).toBe(
      1,
    );
    expect(scan({ 'a.txt': 'AKIAABCDEFGHIJKLMNOP\n' }).status).toBe(1);
    // A Tailscale OAuth client secret pasted into a tracked file (even an example file) is caught,
    // and the report names the file, never the value.
    const ts = scan({
      '.env.example': `X=tskey-client-k1B2c3D4e5F6CNTRL-${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}\n`,
    });
    expect(ts.status).toBe(1);
    expect(ts.out).toMatch(/\.env\.example: looks like a Tailscale/);
    expect(ts.out).not.toContain('a1B2c3D4e5F6g7H8');
    expect(scan({ 'a.txt': 'mongodb://admin:hunter22@db:27017/app\n' }).status).toBe(1);
    expect(scan({ 'a.txt': 'https://example.com/path\n' }).status).toBe(0);
  });

  it('passes for the repository itself', () => {
    const r = spawnSync(process.execPath, [SCANNER], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
