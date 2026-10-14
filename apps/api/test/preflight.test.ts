import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'preflight.mjs');
const dockerCli = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

type Row = {
  group: string;
  status: 'pass' | 'fail' | 'warn' | 'todo';
  title: string;
  detail: string;
};

const secret = () => randomBytes(32).toString('base64url');

/** A complete, valid configuration; each test then breaks exactly one thing. */
function validEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'hlcc-pre-'));
  const dockerToken = secret();
  const setupToken = secret();
  const dockerFile = join(dir, 'docker_token');
  const setupFile = join(dir, 'setup_token');
  writeFileSync(dockerFile, dockerToken, { mode: 0o600 });
  writeFileSync(setupFile, setupToken, { mode: 0o600 });
  const env: Record<string, string> = {
    DOCKER_GID: '1001',
    HLCC_SECRET_DOCKER_TOKEN_FILE: dockerFile.replace(/\\/g, '/'),
    HLCC_SECRET_SETUP_TOKEN_FILE: setupFile.replace(/\\/g, '/'),
    HLCC_DATA_PATH: '/srv/projects/hlcc/data',
    HLCC_PROBE_ROOT: '/srv/projects/hlcc/probe-root',
    HLCC_PROBE_STORAGE: '/srv/storage/hlcc/probe',
    HLCC_DISKS:
      '[{"label":"/","path":"/probe/root"},{"label":"/srv/storage","path":"/probe/storage","separate":true}]',
    HLCC_TRUST_PROXY: '1',
    HLCC_COOKIE_SECURE: 'true',
  };
  return { env, dir, dockerToken, setupToken, dockerFile, setupFile };
}

/** The real environment (the docker CLI needs it) minus anything that would configure the deployment. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(HLCC_|DOCKER_GID$|NODE_ENV$|PROXY_)/.test(k)) out[k] = v;
  }
  return { ...out, ...extra };
}

function run(env: Record<string, string>, args: string[] = []) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--json', '--allow-local-paths', ...(dockerCli ? [] : ['--no-docker']), ...args],
    {
      cwd: ROOT,
      env: cleanEnv(env),
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  let rows: Row[] = [];
  try {
    rows = JSON.parse(r.stdout) as Row[];
  } catch {
    /* leave empty: the assertion on rows will show it */
  }
  return { status: r.status, rows, raw: `${r.stdout}${r.stderr}` };
}

const failing = (rows: Row[]) => rows.filter((r) => r.status === 'fail').map((r) => r.title);
const has = (rows: Row[], re: RegExp) => failing(rows).some((t) => re.test(t));

describe('preflight with a complete, valid configuration', () => {
  it('has no failures, exits 0, and never prints a secret', () => {
    const v = validEnv();
    const r = run(v.env);
    expect(r.rows.length).toBeGreaterThan(30);
    expect(failing(r.rows)).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.raw).not.toContain(v.dockerToken);
    expect(r.raw).not.toContain(v.setupToken);
  });

  it('separates what it verified from what still needs the engine or the server', () => {
    const r = run(validEnv().env);
    const groups = new Set(r.rows.map((x) => x.group));
    for (const g of [
      'verified-locally',
      'requires-admin-config',
      'requires-docker-engine',
      'requires-ubuntu-host',
    ]) {
      expect(groups.has(g), g).toBe(true);
    }
    // The engine and the server are never "passed" by a local script.
    expect(
      r.rows.filter((x) => x.group === 'requires-docker-engine').every((x) => x.status === 'todo'),
    ).toBe(true);
    expect(
      r.rows.filter((x) => x.group === 'requires-ubuntu-host').every((x) => x.status === 'todo'),
    ).toBe(true);
  });

  it('prints a human-readable report by default', () => {
    const v = validEnv();
    const r = spawnSync(process.execPath, [SCRIPT, '--allow-local-paths'], {
      cwd: ROOT,
      env: cleanEnv(v.env),
      encoding: 'utf8',
    });
    expect(r.stdout).toMatch(/== verified-locally ==/);
    expect(r.stdout).toMatch(/\[PASS\]/);
    expect(r.stdout).toMatch(/still to verify on the engine or the server/);
    expect(r.stdout).not.toContain(v.dockerToken);
  });

  it('does not create or change any file in the repository', () => {
    const snapshot = () =>
      ['deploy', 'scripts', 'migrations']
        .map((d) =>
          readdirSync(join(ROOT, d))
            .map((f) => `${d}/${f}:${statSync(join(ROOT, d, f)).mtimeMs}`)
            .join(),
        )
        .join('|');
    const before = snapshot();
    run(validEnv().env);
    expect(snapshot()).toBe(before);
  });
});

describe('preflight catches configuration mistakes', () => {
  const broken = (mutate: (e: Record<string, string>, v: ReturnType<typeof validEnv>) => void) => {
    const v = validEnv();
    mutate(v.env, v);
    const r = run(v.env);
    expect(r.status, `${failing(r.rows).join(' | ')} :: ${r.raw.slice(-300)}`).toBe(1);
    expect(r.raw).not.toContain(v.dockerToken);
    expect(r.raw).not.toContain(v.setupToken);
    return r.rows;
  };

  it('a missing or non-numeric docker group', () => {
    expect(
      has(
        broken((e) => delete e.DOCKER_GID),
        /DOCKER_GID is a number/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.DOCKER_GID = 'docker')),
        /DOCKER_GID is a number/,
      ),
    ).toBe(true);
  });

  it('the root group, which would give the proxy root-group access', () => {
    const v = validEnv();
    v.env.DOCKER_GID = '0';
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
      cwd: ROOT,
      env: cleanEnv(v.env),
      encoding: 'utf8',
    });
    const rows = JSON.parse(r.stdout) as Row[];
    expect(failing(rows).some((t) => /not the root group/.test(t))).toBe(true);
    expect(r.status).toBe(1);
  });

  it('missing, short, repetitive and identical credentials', () => {
    expect(
      has(
        broken((e) => delete e.HLCC_SECRET_DOCKER_TOKEN_FILE),
        /HLCC_SECRET_DOCKER_TOKEN_FILE is set/,
      ),
    ).toBe(true);
    expect(
      has(
        broken(
          (e) =>
            (e.HLCC_SECRET_DOCKER_TOKEN_FILE = join(
              tmpdir(),
              'hlcc-definitely-absent',
              'secret',
            ).replace(/\\/g, '/')),
        ),
        /HLCC_SECRET_DOCKER_TOKEN_FILE/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((_e, v) => writeFileSync(v.dockerFile, 'short', { mode: 0o600 })),
        /credential is long enough/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((_e, v) => writeFileSync(v.dockerFile, 'a'.repeat(64), { mode: 0o600 })),
        /not trivially repetitive/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.HLCC_SECRET_SETUP_TOKEN_FILE = e.HLCC_SECRET_DOCKER_TOKEN_FILE ?? '')),
        /two credentials are different/,
      ),
    ).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('a credential file that other users can read', () => {
    const rows = broken((_e, v) => chmodSync(v.dockerFile, 0o644));
    expect(has(rows, /readable only by its owner/)).toBe(true);
  });

  it('paths that are not absolute Ubuntu paths', () => {
    const v = validEnv();
    v.env.HLCC_DATA_PATH = 'C:\\Users\\me\\data';
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
      cwd: ROOT,
      env: cleanEnv(v.env),
      encoding: 'utf8',
    });
    expect(
      failing(JSON.parse(r.stdout) as Row[]).some((t) =>
        /HLCC_DATA_PATH is an Ubuntu path/.test(t),
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.HLCC_DATA_PATH = './relative/data')),
        /HLCC_DATA_PATH is an absolute path/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => delete e.HLCC_PROBE_ROOT),
        /HLCC_PROBE_ROOT is set/,
      ),
    ).toBe(true);
  });

  it('a storage probe that is the whole mount, or the same directory as the root probe', () => {
    expect(
      has(
        broken((e) => (e.HLCC_PROBE_STORAGE = '/srv/storage')),
        /inside the disk, not the whole mount/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.HLCC_PROBE_STORAGE = e.HLCC_PROBE_ROOT ?? '')),
        /probe directories are different/,
      ),
    ).toBe(true);
  });

  it('a disk list that cannot verify the secondary disk', () => {
    expect(
      has(
        broken((e) => delete e.HLCC_DISKS),
        /valid disk list/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.HLCC_DISKS = 'not json')),
        /valid disk list/,
      ),
    ).toBe(true);
    expect(
      has(
        broken(
          (e) =>
            (e.HLCC_DISKS =
              '[{"label":"/","path":"/probe/root"},{"label":"/srv/storage","path":"/probe/storage"}]'),
        ),
        /marked "separate"/,
      ),
    ).toBe(true);
    expect(
      has(
        broken(
          (e) =>
            (e.HLCC_DISKS =
              '[{"label":"/","path":"/etc"},{"label":"x","path":"/probe/storage","separate":true}]'),
        ),
        /two mounted probe paths/,
      ),
    ).toBe(true);
  });

  it('demo mode, a wild proxy count, or an impossible port', () => {
    expect(
      has(
        broken((e) => (e.HLCC_MODE = 'mock')),
        /live mode/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.HLCC_TRUST_PROXY = '7')),
        /hop count/,
      ),
    ).toBe(true);
    expect(
      has(
        broken((e) => (e.HLCC_PORT = '99999')),
        /valid port/,
      ),
    ).toBe(true);
  });

  it('warns, without failing, about risky but permitted choices', () => {
    const v = validEnv();
    Object.assign(v.env, {
      HLCC_COOKIE_SECURE: 'false',
      HLCC_ALLOW_INSECURE_COOKIES: 'true',
      HLCC_HOST_PROC_ASSERT: 'true',
    });
    const r = run(v.env);
    expect(failing(r.rows)).toEqual([]);
    const warns = r.rows
      .filter((x) => x.status === 'warn')
      .map((x) => x.title)
      .join(' | ');
    expect(warns).toMatch(/Insecure cookies are allowed/);
    expect(warns).toMatch(/Host-metric assertion is on/);
  });

  it('refuses to describe a configuration as ready when values are missing entirely', () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(failing(r.rows).length).toBeGreaterThanOrEqual(6);
  });
});

describe('preflight without the docker CLI', () => {
  // The real PATH minus any directory that holds a docker executable, so git and node still work.
  const withoutDocker = (path: string) =>
    path
      .split(delimiter)
      .filter((d) => d && !existsSync(join(d, 'docker')) && !existsSync(join(d, 'docker.exe')))
      .join(delimiter);
  const noDockerEnv = (v: ReturnType<typeof validEnv>) => {
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    return cleanEnv({ ...v.env, [pathKey]: withoutDocker(process.env[pathKey] ?? '') });
  };
  const spawn = (v: ReturnType<typeof validEnv>, extra: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json', '--allow-local-paths', ...extra], {
      cwd: ROOT,
      env: noDockerEnv(v),
      encoding: 'utf8',
    });
    return { status: r.status, rows: JSON.parse(r.stdout) as Row[] };
  };

  it('fails rather than quietly skipping the compose checks (no false all-clear)', () => {
    const r = spawn(validEnv(), []);
    expect(r.status).toBe(1);
    expect(failing(r.rows).some((t) => /docker compose CLI is available/.test(t))).toBe(true);
  });

  it('accepts --no-docker, but then reports the compose structure as NOT verified, never as passed', () => {
    const r = spawn(validEnv(), ['--no-docker']);
    expect(failing(r.rows)).toEqual([]);
    const compose = r.rows.filter((x) => x.group === 'requires-docker-cli');
    expect(compose.length).toBeGreaterThan(0);
    expect(compose.every((x) => x.status === 'todo')).toBe(true);
    expect(compose[0]!.detail).toMatch(/NOT verified/);
  });
});

describe.runIf(dockerCli)('preflight inspects the rendered compose file', () => {
  const fixture = (
    change: (yaml: string) => string,
    dir = mkdtempSync(join(tmpdir(), 'hlcc-compose-')),
  ) => {
    const v = validEnv();
    const secretPath = v.dockerFile.replace(/\\/g, '/');
    const base = `name: fixture
services:
  docker-proxy:
    image: proxy:test
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    mem_limit: 64m
    pids_limit: 64
    logging: { driver: json-file, options: { max-size: 10m } }
    volumes: ['/var/run/docker.sock:/var/run/docker.sock']
    secrets: [t]
    networks: [hlcc-docker]
  hlcc:
    image: hlcc:test
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    mem_limit: 256m
    pids_limit: 128
    logging: { driver: json-file, options: { max-size: 10m } }
    depends_on: { docker-proxy: { condition: service_healthy } }
    ports: ['127.0.0.1:8787:8787']
    environment: { HLCC_COOKIE_SECURE: 'true', HLCC_DOCKER_TOKEN_FILE: /run/secrets/t }
    volumes: ['/srv/d:/data', '/srv/r:/probe/root:ro', '/srv/s:/probe/storage:ro']
    secrets: [t]
    networks: [hlcc-internal, hlcc-docker]
secrets:
  t: { file: ${secretPath} }
networks:
  hlcc-internal: {}
  hlcc-docker: { internal: true }
`;
    const file = join(dir, 'compose.yaml');
    writeFileSync(file, change(base));
    const r = run(v.env, ['--compose', file]);
    return { ...r, failures: failing(r.rows).filter((t) => !/administrator-provided/.test(t)) };
  };

  it('accepts a structurally correct file', () => {
    const r = fixture((y) => y);
    expect(r.failures).toEqual([]);
  });

  const cases: [string, (y: string) => string, RegExp][] = [
    [
      'the API mounting the Docker socket',
      (y) =>
        y.replace(
          "volumes: ['/srv/d:/data'",
          "volumes: ['/var/run/docker.sock:/var/run/docker.sock', '/srv/d:/data'",
        ),
      /API has no Docker socket mount/,
    ],
    [
      'a service mounting the host root',
      (y) => y.replace("'/srv/d:/data'", "'/:/data'"),
      /No service mounts/,
    ],
    [
      'the dashboard published on every interface',
      (y) => y.replace("'127.0.0.1:8787:8787'", "'8787:8787'"),
      /127\.0\.0\.1 only/,
    ],
    [
      'the dashboard published on a LAN address',
      (y) => y.replace("'127.0.0.1:8787:8787'", "'0.0.0.0:8787:8787'"),
      /127\.0\.0\.1 only/,
    ],
    [
      'the proxy publishing a port',
      (y) =>
        y.replace(
          '    secrets: [t]\n    networks: [hlcc-docker]',
          "    secrets: [t]\n    ports: ['2375:2375']\n    networks: [hlcc-docker]",
        ),
      /proxy publishes no host port/,
    ],
    [
      'a privileged container',
      (y) => y.replace('image: hlcc:test', 'image: hlcc:test\n    privileged: true'),
      /hlcc: no privileged configuration/,
    ],
    // Compose itself refuses to combine host networking with a networks list; either way it must not pass.
    [
      'host networking',
      (y) => y.replace('image: hlcc:test', 'image: hlcc:test\n    network_mode: host'),
      /renders|hlcc: no privileged configuration/,
    ],
    [
      'an added capability',
      (y) => y.replace('image: proxy:test', 'image: proxy:test\n    cap_add: [SYS_ADMIN]'),
      /docker-proxy: no privileged configuration/,
    ],
    [
      'a writable root filesystem',
      (y) =>
        y.replace(
          'image: hlcc:test\n    restart: unless-stopped\n    read_only: true',
          'image: hlcc:test\n    restart: unless-stopped',
        ),
      /hlcc: no privileged configuration/,
    ],
    [
      'capabilities not dropped',
      (y) =>
        y.replace(
          'image: proxy:test\n    restart: unless-stopped\n    read_only: true\n    cap_drop: [ALL]',
          'image: proxy:test\n    restart: unless-stopped\n    read_only: true',
        ),
      /docker-proxy: no privileged configuration/,
    ],
    [
      'a secret passed as a plain environment variable',
      (y) =>
        y.replace(
          "environment: { HLCC_COOKIE_SECURE: 'true'",
          "environment: { HLCC_DOCKER_TOKEN: abc, HLCC_COOKIE_SECURE: 'true'",
        ),
      /no secret value is passed as an environment variable/,
    ],
    [
      'a proxy on a network with a route out',
      (y) => y.replace('hlcc-docker: { internal: true }', 'hlcc-docker: {}'),
      /internal network with no route out/,
    ],
    [
      'a missing memory limit',
      (y) => y.replace('    mem_limit: 256m\n', ''),
      /hlcc: memory and process limits/,
    ],
    [
      'unbounded logs',
      (y) =>
        y.replace(
          '    logging: { driver: json-file, options: { max-size: 10m } }\n    depends_on',
          '    depends_on',
        ),
      /hlcc: container logs are bounded/,
    ],
    [
      'an API that does not wait for a healthy proxy',
      (y) => y.replace('condition: service_healthy', 'condition: service_started'),
      /waits for a healthy proxy/,
    ],
    [
      'a writable probe mount',
      (y) => y.replace("'/srv/r:/probe/root:ro'", "'/srv/r:/probe/root'"),
      /\/probe\/root is mounted read-only/,
    ],
    [
      'no restart policy',
      (y) =>
        y.replace(
          "    restart: unless-stopped\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: ['no-new-privileges:true']\n    mem_limit: 256m",
          "    read_only: true\n    cap_drop: [ALL]\n    security_opt: ['no-new-privileges:true']\n    mem_limit: 256m",
        ),
      /hlcc: has a restart policy/,
    ],
  ];
  it.each(cases)('rejects %s', (_name, change, re) => {
    const r = fixture(change);
    expect(r.status, `${r.failures.join(' | ')} :: ${r.raw.slice(-300)}`).toBe(1);
    expect(
      r.failures.some((t) => re.test(t)),
      r.failures.join(' | '),
    ).toBe(true);
  });
});
