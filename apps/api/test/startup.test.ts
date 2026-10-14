import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'correct horse battery';
const PROXY_TOKEN = 'test-only-docker-token-0123456789abcdef0123456789';
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

interface Running {
  port: number;
  dataDir: string;
  output: () => string;
  exited: Promise<number | null>;
  child: ChildProcess;
  listening: () => Promise<void>;
  url: (p: string) => string;
}

/** Runs the real server as a separate process, with only the environment the test gives it. */
function start(
  env: Record<string, string>,
  dataDir = mkdtempSync(join(tmpdir(), 'hlcc-run-')),
): Running {
  const port = 21_000 + Math.floor(Math.random() * 8_000);
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME'])
    if (process.env[k]) base[k] = process.env[k]!;
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: API_DIR,
    env: {
      ...base,
      HLCC_PORT: String(port),
      HLCC_DATA_DIR: dataDir,
      HLCC_LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d));
  child.stderr!.on('data', (d: Buffer) => (out += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const listening = async () => {
    const t0 = Date.now();
    while (!out.includes('API listening')) {
      if (child.exitCode !== null) throw new Error(`exited early (${child.exitCode}): ${out}`);
      if (Date.now() - t0 > 15_000) throw new Error(`did not start: ${out}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  return {
    port,
    dataDir,
    output: () => out,
    exited,
    child,
    listening,
    url: (p) => `http://127.0.0.1:${port}${p}`,
  };
}

const post = (r: Running, path: string, body: object) =>
  fetch(r.url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('first-run setup token', () => {
  it('is never logged: a generated one goes to a private file, and only the path is printed', async () => {
    const r = start({});
    await r.listening();
    const file = join(r.dataDir, 'setup-token');
    expect(existsSync(file)).toBe(true);
    const token = readFileSync(file, 'utf8').trim();
    expect(token.length).toBeGreaterThanOrEqual(20);
    expect(r.output()).not.toContain(token);
    expect(r.output()).toContain('setup-token'); // the path is mentioned
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const res = await post(r, '/api/v1/auth/setup', {
      setupToken: token,
      username: 'admin',
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(existsSync(file)).toBe(false); // removed as soon as it has been used
    expect(r.output()).not.toContain(token);
    expect(r.output()).not.toContain(PASSWORD);
  });

  it('is not regenerated after setup, and a restart cannot be used to set up again', async () => {
    const first = start({});
    await first.listening();
    const token = readFileSync(join(first.dataDir, 'setup-token'), 'utf8').trim();
    await post(first, '/api/v1/auth/setup', {
      setupToken: token,
      username: 'admin',
      password: PASSWORD,
    });
    first.child.kill('SIGKILL');
    await first.exited;

    const second = start({}, first.dataDir);
    await second.listening();
    expect(existsSync(join(second.dataDir, 'setup-token'))).toBe(false);
    expect(second.output()).not.toContain('First-run setup required');
    const again = await post(second, '/api/v1/auth/setup', {
      setupToken: token,
      username: 'x',
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
    // The administrator account survived the restart.
    expect(
      (await post(second, '/api/v1/auth/login', { username: 'admin', password: PASSWORD })).status,
    ).toBe(200);
  }, 30_000);

  it('uses a configured token without ever echoing it', async () => {
    const token = 'configured-setup-token-abcdef123456';
    const r = start({ HLCC_SETUP_TOKEN: token });
    await r.listening();
    expect(r.output()).not.toContain(token);
    expect(existsSync(join(r.dataDir, 'setup-token'))).toBe(false);
    expect(
      (
        await post(r, '/api/v1/auth/setup', {
          setupToken: token,
          username: 'admin',
          password: PASSWORD,
        })
      ).status,
    ).toBe(201);
  });

  it('works when optional variables are present but empty, as Compose passes them', async () => {
    const r = start({
      HLCC_SETUP_TOKEN: '',
      HLCC_DOCKER_URL: '',
      HLCC_DOCKER_TOKEN: '',
      HLCC_DISKS: '',
      HLCC_NETDATA_URL: '',
      HLCC_WEB_DIST: '',
      HLCC_ALLOWED_ORIGINS: '',
      HLCC_HOST_PROC_ASSERT: 'false',
    });
    await r.listening();
    const token = readFileSync(join(r.dataDir, 'setup-token'), 'utf8').trim();
    expect(
      (
        await post(r, '/api/v1/auth/setup', {
          setupToken: token,
          username: 'admin',
          password: PASSWORD,
        })
      ).status,
    ).toBe(201);
  });
});

describe('production refuses to start insecurely', () => {
  const prod = { NODE_ENV: 'production', HLCC_COOKIE_SECURE: 'true' };

  it('without a setup token when the administrator does not exist yet', async () => {
    const r = start(prod);
    expect(await r.exited).toBe(1);
    expect(r.output()).toMatch(/HLCC_SETUP_TOKEN/);
    expect(r.output()).not.toContain('API listening');
    expect(existsSync(join(r.dataDir, 'setup-token'))).toBe(false); // it did not quietly invent one
  });

  it('with non-Secure cookies unless that risk is accepted explicitly', async () => {
    const r = start({
      NODE_ENV: 'production',
      HLCC_SETUP_TOKEN: 'configured-setup-token-abcdef123456',
    });
    expect(await r.exited).toBe(1);
    expect(r.output()).toMatch(/HLCC_COOKIE_SECURE/);
  });

  it('with a Docker proxy URL but no credential', async () => {
    const r = start({
      ...prod,
      HLCC_SETUP_TOKEN: 'configured-setup-token-abcdef123456',
      HLCC_DOCKER_URL: 'http://127.0.0.1:1',
    });
    expect(await r.exited).toBe(1);
    expect(r.output()).toMatch(/HLCC_DOCKER_TOKEN/);
  });

  it('with a weak Docker credential, without printing it', async () => {
    const r = start({
      ...prod,
      HLCC_SETUP_TOKEN: 'configured-setup-token-abcdef123456',
      HLCC_DOCKER_URL: 'http://127.0.0.1:1',
      HLCC_DOCKER_TOKEN: 'weak-credential-value',
    });
    expect(await r.exited).toBe(1);
    expect(r.output()).toMatch(/at least 32/);
    expect(r.output()).not.toContain('weak-credential-value');
  });

  it('starts when everything required is present, reading secrets from files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hlcc-secrets-'));
    const setupFile = join(dir, 'setup');
    const dockerFile = join(dir, 'docker');
    writeFileSync(setupFile, 'file-based-setup-token-abcdef123456\n');
    writeFileSync(dockerFile, `${PROXY_TOKEN}\n`);
    const r = start({
      ...prod,
      HLCC_SETUP_TOKEN_FILE: setupFile,
      HLCC_DOCKER_TOKEN_FILE: dockerFile,
      HLCC_DOCKER_URL: 'http://127.0.0.1:1',
      HLCC_MODE: 'live',
    });
    await r.listening();
    expect(r.output()).not.toContain('file-based-setup-token');
    expect(r.output()).not.toContain(PROXY_TOKEN);
    const res = await fetch(r.url('/api/v1/auth/status'));
    expect(((await res.json()) as { setupRequired: boolean }).setupRequired).toBe(true);
  });

  it('refuses a missing secret file instead of falling back to a default', async () => {
    const r = start({
      ...prod,
      HLCC_SETUP_TOKEN_FILE: join(tmpdir(), 'definitely-not-here', 'secret'),
    });
    expect(await r.exited).toBe(1);
    expect(r.output()).toMatch(/could not be read/);
  });
});

describe('live mode with an unreachable Docker proxy', () => {
  it('keeps running, reports the failure, and never prints the credential', async () => {
    const r = start({
      HLCC_MODE: 'live',
      HLCC_DOCKER_URL: 'http://127.0.0.1:1',
      HLCC_DOCKER_TOKEN: PROXY_TOKEN,
      HLCC_SETUP_TOKEN: 'configured-setup-token-abcdef123456',
      HLCC_POLL_INTERVAL_MS: '5000',
    });
    await r.listening();
    const setup = await post(r, '/api/v1/auth/setup', {
      setupToken: 'configured-setup-token-abcdef123456',
      username: 'admin',
      password: PASSWORD,
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const t0 = Date.now();
    type OverviewBody = {
      docker: { freshness: string };
      collectorErrors: { docker: { message: string } | null };
      mode: string;
    };
    let body = null as OverviewBody | null;
    while (Date.now() - t0 < 10_000) {
      const o = await fetch(r.url('/api/v1/overview'), { headers: { cookie } });
      body = (await o.json()) as OverviewBody;
      if (body?.collectorErrors.docker) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(body?.mode).toBe('live');
    expect(body?.docker.freshness).toBe('unavailable');
    expect(body?.collectorErrors.docker?.message).toMatch(/Docker unavailable/);
    expect(JSON.stringify(body)).not.toContain(PROXY_TOKEN);
    expect(r.output()).not.toContain(PROXY_TOKEN);
    expect(r.child.exitCode).toBeNull(); // still alive
  }, 30_000);
});

describe.runIf(process.platform !== 'win32')('shutdown', () => {
  it('exits cleanly on SIGTERM even with an open event stream', async () => {
    const r = start({ HLCC_SETUP_TOKEN: 'configured-setup-token-abcdef123456' });
    await r.listening();
    const setup = await post(r, '/api/v1/auth/setup', {
      setupToken: 'configured-setup-token-abcdef123456',
      username: 'admin',
      password: PASSWORD,
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const stream = await fetch(r.url('/api/v1/stream'), { headers: { cookie } });
    expect(stream.status).toBe(200);
    const started = Date.now();
    r.child.kill('SIGTERM');
    expect(await r.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 30_000);
});
