#!/usr/bin/env node
// Deployment preflight. Read-only: it renders and inspects configuration, it never starts a
// container, touches a server, or prints a secret value (only names, lengths and verdicts).
//
//   node scripts/preflight.mjs [--env-file <path>] [--compose <file>] [--json] [--allow-local-paths]
//
// --allow-local-paths accepts Windows paths and DOCKER_GID=0, for dry runs on a developer machine.
// --no-docker skips the Compose structure checks (they are then reported as NOT verified, never as passed).
// Checks are grouped by what is needed to verify them:
//   verified-locally       needs nothing but this repository
//   requires-docker-cli    needs the `docker compose` CLI (not the Docker engine)
//   requires-admin-config  needs the values the administrator will provide
//   requires-docker-engine NOT run here; listed with the commands to run
//   requires-ubuntu-host   NOT run here; listed with read-only commands for the server
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

const composeFile = opt('--compose') ?? join(root, 'deploy', 'compose.yaml');
const allowLocal = flag('--allow-local-paths');
const asJson = flag('--json');

const results = [];
const add = (group, status, title, detail = '') => results.push({ group, status, title, detail });
const pass = (g, t, d) => add(g, 'pass', t, d);
const fail = (g, t, d) => add(g, 'fail', t, d);
const warn = (g, t, d) => add(g, 'warn', t, d);
const todo = (g, t, d) => add(g, 'todo', t, d);

// ---- environment (values are used, never printed) ---------------------------------------------
function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const envFilePath = opt('--env-file');
let fileEnv = {};
if (envFilePath) {
  try {
    fileEnv = parseEnvFile(envFilePath);
  } catch {
    fail(
      'requires-admin-config',
      'Environment file is readable',
      `${envFilePath} could not be read`,
    );
  }
}
const env = { ...fileEnv, ...process.env }; // the shell wins over the file, as Compose does
const isPosixAbs = (p) => typeof p === 'string' && p.startsWith('/');
const looksWindows = (p) => /^[A-Za-z]:[\\/]/.test(p ?? '') || /\\/.test(p ?? '');

// ---- verified locally -------------------------------------------------------------------------
const G1 = 'verified-locally';
{
  // Migrations: numbered without gaps, and they actually build the schema.
  const dir = join(root, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const gaps = files.some((f, i) => Number(f.split('_')[0]) !== i + 1);
  if (files.length === 0 || gaps)
    fail(G1, 'Migrations are numbered 001.. without gaps', files.join(', '));
  else pass(G1, 'Migrations are numbered without gaps', `${files.length} files`);
  try {
    const db = await import(pathToFileURL(join(root, 'apps/api/src/db.ts')).href);
    const mem = db.openDb(':memory:');
    const ran = db.migrate(mem, dir);
    let appendOnly = false;
    try {
      mem.exec(
        "INSERT INTO audit_events (ts, actor, action, outcome) VALUES (1,'x','y','success')",
      );
      mem.exec('DELETE FROM audit_events');
    } catch {
      appendOnly = true;
    }
    if (ran.length === files.length && appendOnly)
      pass(G1, 'Migrations build a fresh database and the audit table is append-only');
    else
      fail(
        G1,
        'Migrations build a fresh database and the audit table is append-only',
        `ran ${ran.length}/${files.length}, append-only=${appendOnly}`,
      );
  } catch (e) {
    fail(G1, 'Migrations build a fresh database', e.message);
  }

  // Dockerfile policy.
  const dockerfile = readFileSync(join(root, 'deploy', 'Dockerfile'), 'utf8');
  const stages = dockerfile
    .split(/^FROM /m)
    .slice(1)
    .filter((s) => /^\$\{NODE_IMAGE\} AS (api|proxy)/m.test(s));
  const ok =
    stages.length === 2 && stages.every((s) => /^USER node$/m.test(s) && /^HEALTHCHECK /m.test(s));
  (ok ? pass : fail)(
    G1,
    'Both runtime images run as a non-root user and define a healthcheck',
    `${stages.length} runtime stages inspected`,
  );
  const pinned = /^ARG NODE_IMAGE=.+@sha256:[0-9a-f]{64}\s*$/m.test(dockerfile);
  (pinned ? pass : fail)(
    G1,
    'Base image is pinned by digest (reproducible builds)',
    pinned ? '' : 'NODE_IMAGE has no @sha256 digest; see docs/deployment.md',
  );
  (/npm ci/.test(dockerfile) && /--ignore-scripts/.test(dockerfile) ? pass : fail)(
    G1,
    'Images install from the lockfile without running install scripts',
  );

  const di = existsSync(join(root, '.dockerignore'))
    ? readFileSync(join(root, '.dockerignore'), 'utf8')
    : '';
  const need = ['.env', 'node_modules', 'secrets', 'data'];
  // "**/node_modules" and "node_modules" are both valid ways to exclude it.
  const missing = need.filter(
    (n) => !new RegExp(`^(\\*\\*/)?${n.replace('.', '\\.')}$`, 'm').test(di),
  );
  (missing.length ? fail : pass)(
    G1,
    '.dockerignore keeps secrets and local state out of the build context',
    missing.join(', '),
  );

  // Documentation the runbook depends on.
  const docs = [
    'README.md',
    'docs/deployment.md',
    'docs/security.md',
    'docs/operations.md',
    'docs/backup-and-recovery.md',
    'docs/live-monitoring.md',
  ];
  const absent = docs.filter((d) => !existsSync(join(root, d)));
  (absent.length ? fail : pass)(
    G1,
    'Deployment, security, operations and backup documents exist',
    absent.join(', '),
  );
  const dep = existsSync(join(root, 'docs/deployment.md'))
    ? readFileSync(join(root, 'docs/deployment.md'), 'utf8')
    : '';
  const bak = existsSync(join(root, 'docs/backup-and-recovery.md'))
    ? readFileSync(join(root, 'docs/backup-and-recovery.md'), 'utf8')
    : '';
  (/rollback/i.test(dep) && /migration/i.test(dep) ? pass : fail)(
    G1,
    'Deployment guide documents rollback and migrations',
  );
  (/001_init|003_audit|schema_migrations/.test(bak) ? pass : warn)(
    G1,
    'Backup guide matches the current schema',
    'mentions migrations or tables',
  );

  // Secret scan of everything that could be committed.
  const scan = spawnSync(process.execPath, [join(root, 'scripts', 'check-secrets.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  (scan.status === 0 ? pass : fail)(
    G1,
    'Secret scan of tracked and uncommitted files is clean',
    scan.status === 0
      ? (scan.stdout.trim().split('\n').pop() ?? '')
      : 'findings listed by `npm run scan`',
  );

  // The browser bundle must not contain server credentials or their variable names.
  const dist = join(root, 'apps', 'web', 'dist');
  if (existsSync(dist)) {
    const markers = ['HLCC_DOCKER_TOKEN', 'PROXY_TOKEN', 'HLCC_SETUP_TOKEN', 'docker_proxy_token'];
    for (const k of ['HLCC_SECRET_DOCKER_TOKEN_FILE', 'HLCC_SECRET_SETUP_TOKEN_FILE']) {
      const f = env[k];
      if (f && existsSync(f)) markers.push(readFileSync(f, 'utf8').trim());
    }
    let leaked = null;
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else {
          const text = readFileSync(p, 'utf8');
          const hit = markers.find((m) => m.length >= 8 && text.includes(m));
          if (hit && !leaked) leaked = p;
        }
      }
    };
    walk(dist);
    (leaked ? fail : pass)(
      G1,
      'Production web bundle contains no server credentials',
      leaked ? `found in ${leaked.replace(root, '.')}` : '',
    );
  } else {
    todo(G1, 'Production web bundle contains no server credentials', 'run `npm run build` first');
  }

  // The configuration loader must fail closed. Self-test with synthetic, non-secret values.
  try {
    const { loadConfig } = await import(pathToFileURL(join(root, 'apps/api/src/config.ts')).href);
    const strong = 'Zk3vQ9mT4xW7bN2pL8cR5dF1gH6jY0sA'; // synthetic, varied, not a real secret
    const must = [
      ['production without Secure cookies', { NODE_ENV: 'production' }],
      ['a Docker URL without a credential', { HLCC_DOCKER_URL: 'http://docker-proxy:2375' }],
      [
        'a weak Docker credential',
        { HLCC_DOCKER_URL: 'http://docker-proxy:2375', HLCC_DOCKER_TOKEN: 'weak' },
      ],
      ['a short setup token', { HLCC_SETUP_TOKEN: 'short' }],
    ];
    const lenient = must.filter(([, e]) => {
      try {
        loadConfig(e);
        return true;
      } catch {
        return false;
      }
    });
    (lenient.length ? fail : pass)(
      G1,
      'Configuration refuses insecure settings',
      lenient.map(([n]) => `accepted ${n}`).join('; '),
    );
    try {
      loadConfig({
        NODE_ENV: 'production',
        HLCC_COOKIE_SECURE: 'true',
        HLCC_DOCKER_URL: 'http://docker-proxy:2375',
        HLCC_DOCKER_TOKEN: strong,
      });
      pass(G1, 'Configuration accepts a complete secure setup');
    } catch (e) {
      fail(G1, 'Configuration accepts a complete secure setup', e.message);
    }
  } catch (e) {
    fail(G1, 'Configuration loads', e.message);
  }
}

// ---- compose (needs only the docker CLI) ------------------------------------------------------
const G2 = 'requires-docker-cli';
const G3 = 'requires-admin-config';
let rendered = null;
{
  const cli = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (cli.status !== 0) {
    // Silently skipping would give a false all-clear, so a missing CLI is a failure unless the
    // caller says they accept that the Compose structure goes unchecked.
    if (flag('--no-docker')) {
      todo(
        G2,
        'Compose configuration renders and passes the structural checks',
        'skipped by --no-docker: NOT verified',
      );
    } else {
      fail(
        G2,
        'The docker compose CLI is available to render and check the file',
        'install it on the machine running the preflight, or pass --no-docker to leave the Compose structure unverified',
      );
    }
  } else {
    const render = (extraEnv) => {
      const args = [
        'compose',
        ...(envFilePath ? ['--env-file', envFilePath] : []),
        '-f',
        composeFile,
        'config',
        '--format',
        'json',
      ];
      return spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
    };
    let r = render({});
    let placeholder = false;
    if (r.status !== 0) {
      // The administrator's values are incomplete: say which ones, then still check the structure.
      const msg =
        (r.stderr || '').split('\n').find((l) => /required variable|interpolat/.test(l)) ??
        'Compose could not render';
      fail(
        G3,
        'Compose renders with the administrator-provided values',
        msg.replace(/\s+/g, ' ').slice(0, 220),
      );
      const dir = mkdtempSync(join(tmpdir(), 'hlcc-pre-'));
      const dummy = join(dir, 'secret');
      writeFileSync(dummy, 'x'.repeat(40));
      r = render({
        DOCKER_GID: env.DOCKER_GID ?? '999',
        HLCC_DISKS: env.HLCC_DISKS ?? '[]',
        HLCC_DATA_PATH: env.HLCC_DATA_PATH ?? '/srv/placeholder/data',
        HLCC_PROBE_ROOT: env.HLCC_PROBE_ROOT ?? '/srv/placeholder/root',
        HLCC_PROBE_STORAGE: env.HLCC_PROBE_STORAGE ?? '/srv/placeholder/storage',
        HLCC_SECRET_DOCKER_TOKEN_FILE: env.HLCC_SECRET_DOCKER_TOKEN_FILE ?? dummy,
        HLCC_SECRET_SETUP_TOKEN_FILE: env.HLCC_SECRET_SETUP_TOKEN_FILE ?? dummy,
      });
      placeholder = true;
    }
    if (r.status !== 0) {
      fail(G2, 'Compose configuration renders', (r.stderr || '').split('\n')[0].slice(0, 200));
    } else {
      rendered = JSON.parse(r.stdout);
      pass(
        G2,
        'Compose configuration renders',
        placeholder ? 'structure checked with placeholder values' : 'with your values',
      );
    }
  }
}

if (rendered) {
  const svcs = rendered.services ?? {};
  const names = Object.keys(svcs).sort();
  (names.join() === 'docker-proxy,hlcc' ? pass : fail)(
    G2,
    'Exactly two services: docker-proxy and hlcc',
    names.join(', '),
  );

  const sockets = (s) =>
    (s.volumes ?? []).filter((v) => /docker\.sock/.test(String(v.source ?? '')));
  const wide = (s) =>
    (s.volumes ?? []).filter((v) =>
      ['/', '/var/run', '/run', '/proc', '/sys', '/etc'].includes(String(v.source ?? '')),
    );
  (sockets(svcs['docker-proxy'] ?? {}).length === 1 &&
    names.filter((n) => sockets(svcs[n]).length).join() === 'docker-proxy'
    ? pass
    : fail)(G2, 'The proxy is the only service that mounts the Docker socket');
  (sockets(svcs.hlcc ?? {}).length === 0 ? pass : fail)(G2, 'The API has no Docker socket mount');
  (names.every((n) => wide(svcs[n]).length === 0) ? pass : fail)(
    G2,
    'No service mounts /, /etc, /proc, /sys or /run from the host',
  );

  const ports = (n) => svcs[n]?.ports ?? [];
  const exposed = ports('hlcc').filter((p) => p.host_ip !== '127.0.0.1');
  (ports('hlcc').length > 0 && exposed.length === 0 ? pass : fail)(
    G2,
    'The dashboard is published on 127.0.0.1 only',
    exposed.length ? 'a port is bound to another interface' : '',
  );
  (ports('docker-proxy').length === 0 ? pass : fail)(G2, 'The proxy publishes no host port');

  for (const n of names) {
    const s = svcs[n];
    const bad = [];
    if (s.privileged) bad.push('privileged');
    if (s.network_mode === 'host') bad.push('host network');
    if (s.pid === 'host') bad.push('host pid');
    if (s.ipc === 'host') bad.push('host ipc');
    if ((s.cap_add ?? []).length) bad.push('cap_add');
    if (!(s.cap_drop ?? []).includes('ALL')) bad.push('capabilities not dropped');
    if (!(s.security_opt ?? []).includes('no-new-privileges:true'))
      bad.push('no-new-privileges missing');
    if (s.read_only !== true) bad.push('writable root filesystem');
    (bad.length ? fail : pass)(G2, `${n}: no privileged configuration`, bad.join(', '));
    (Number(s.mem_limit) > 0 && Number(s.pids_limit) > 0 ? pass : fail)(
      G2,
      `${n}: memory and process limits are set`,
      s.mem_limit ? `${Math.round(Number(s.mem_limit) / 1048576)} MiB` : '',
    );
    (/unless-stopped|on-failure|always/.test(s.restart ?? '') ? pass : fail)(
      G2,
      `${n}: has a restart policy`,
      s.restart ?? 'none',
    );
    (s.logging?.options?.['max-size'] ? pass : fail)(G2, `${n}: container logs are bounded`);
    const envKeys = Object.keys(s.environment ?? {});
    const direct = envKeys.filter((k) =>
      /^(HLCC_DOCKER_TOKEN|HLCC_SETUP_TOKEN|PROXY_TOKEN)$/.test(k),
    );
    (direct.length ? fail : pass)(
      G2,
      `${n}: no secret value is passed as an environment variable`,
      direct.join(', '),
    );
  }

  const nets = (n) => Object.keys(svcs[n]?.networks ?? {});
  (nets('docker-proxy').join() === 'hlcc-docker' &&
    rendered.networks?.['hlcc-docker']?.internal === true
    ? pass
    : fail)(G2, 'The proxy is only on an internal network with no route out');
  (nets('hlcc').includes('hlcc-docker') ? pass : fail)(
    G2,
    'The API shares that internal network with the proxy',
  );
  (svcs.hlcc?.depends_on?.['docker-proxy']?.condition === 'service_healthy' ? pass : fail)(
    G2,
    'The API waits for a healthy proxy',
  );
  (Object.keys(svcs.hlcc?.secrets ?? {}).length >= 1 || (svcs.hlcc?.secrets ?? []).length >= 1
    ? pass
    : fail)(G2, 'Secrets are delivered as mounted files');
  const hl = svcs.hlcc?.environment ?? {};
  (hl.HLCC_COOKIE_SECURE === 'true' ? pass : warn)(
    G3,
    'Cookies are Secure',
    `HLCC_COOKIE_SECURE=${hl.HLCC_COOKIE_SECURE ?? 'unset'}`,
  );
  const volumes = svcs.hlcc?.volumes ?? [];
  const data = volumes.find((v) => v.target === '/data');
  (data &&
    (isPosixAbs(String(data.source)) || (allowLocal && /^[A-Za-z]:/.test(String(data.source))))
    ? pass
    : fail)(
    G2,
    'Persistent data is a host directory outside the container',
    data ? '' : 'no /data mount',
  );
  for (const t of ['/probe/root', '/probe/storage']) {
    const v = volumes.find((x) => x.target === t);
    (v && v.read_only === true ? pass : fail)(G2, `${t} is mounted read-only`);
  }
}

// ---- administrator-provided configuration ----------------------------------------------------
{
  const need = (cond, title, detail) => (cond ? pass : fail)(G3, title, cond ? '' : detail);

  const gid = env.DOCKER_GID;
  need(/^\d+$/.test(gid ?? ''), 'DOCKER_GID is a number', 'unset or not numeric');
  if (/^\d+$/.test(gid ?? '') && Number(gid) === 0) {
    (allowLocal ? warn : fail)(
      G3,
      'DOCKER_GID is not the root group',
      'gid 0 would give the proxy root-group access; use the docker group id',
    );
  }

  const secrets = [
    ['HLCC_SECRET_DOCKER_TOKEN_FILE', 32],
    ['HLCC_SECRET_SETUP_TOKEN_FILE', 16],
  ];
  const contents = [];
  for (const [name, min] of secrets) {
    const p = env[name];
    if (!p) {
      fail(G3, `${name} is set`, 'unset');
      continue;
    }
    if (looksWindows(p) && !allowLocal) {
      fail(G3, `${name} is an Ubuntu path`, 'looks like a Windows path');
      continue;
    }
    if (!isPosixAbs(p) && !looksWindows(p)) {
      fail(G3, `${name} is an absolute path`, 'not absolute');
      continue;
    }
    if (isPosixAbs(p) && process.platform === 'win32' && !existsSync(p)) {
      todo(
        'requires-ubuntu-host',
        `${name} exists, has 32+ characters and is readable only by its owner`,
        `check on the server: ${p}`,
      );
      continue;
    }
    if (!existsSync(p)) {
      fail(G3, `${name} points to an existing file`, 'file not found');
      continue;
    }
    const text = readFileSync(p, 'utf8').trim();
    contents.push(text);
    need(
      text.length >= min && /^[A-Za-z0-9._~+/=-]+$/.test(text),
      `${name}: credential is long enough`,
      `needs at least ${min} characters of [A-Za-z0-9._~+/=-] (found ${text.length})`,
    );
    need(
      new Set(text).size >= 12,
      `${name}: credential is not trivially repetitive`,
      `only ${new Set(text).size} distinct characters; generate it randomly`,
    );
    if (process.platform !== 'win32') {
      const mode = statSync(p).mode & 0o777;
      need(
        (mode & 0o077) === 0,
        `${name}: readable only by its owner`,
        `mode is ${mode.toString(8)}; run chmod 400`,
      );
    }
  }
  if (contents.length === 2)
    need(contents[0] !== contents[1], 'The two credentials are different', 'identical values');

  for (const name of ['HLCC_DATA_PATH', 'HLCC_PROBE_ROOT', 'HLCC_PROBE_STORAGE']) {
    const p = env[name];
    if (!p) {
      fail(G3, `${name} is set`, 'unset');
      continue;
    }
    if (looksWindows(p) && !allowLocal)
      fail(G3, `${name} is an Ubuntu path`, 'looks like a Windows path');
    else if (!isPosixAbs(p) && !looksWindows(p))
      fail(G3, `${name} is an absolute path`, 'not absolute');
    else pass(G3, `${name} is an absolute path`);
  }
  if (env.HLCC_PROBE_STORAGE === '/srv/storage' || env.HLCC_PROBE_STORAGE === '/srv/storage/') {
    fail(
      G3,
      'The storage probe is a directory inside the disk, not the whole mount',
      'mounting /srv/storage itself would expose its contents',
    );
  }
  if (env.HLCC_PROBE_ROOT && env.HLCC_PROBE_ROOT === env.HLCC_PROBE_STORAGE)
    fail(G3, 'The two probe directories are different', 'identical');

  let disks = null;
  try {
    const { diskConfigSchema } = await import(
      pathToFileURL(join(root, 'apps/api/src/providers/host.ts')).href
    );
    disks = diskConfigSchema.parse(JSON.parse(env.HLCC_DISKS ?? ''));
  } catch {
    fail(G3, 'HLCC_DISKS is a valid disk list', 'unset or malformed');
  }
  if (disks) {
    const paths = disks
      .map((d) => d.path)
      .sort()
      .join();
    need(
      paths === '/probe/root,/probe/storage',
      'HLCC_DISKS refers to the two mounted probe paths',
      `found ${paths}`,
    );
    need(
      disks.some((d) => d.separate),
      'The secondary disk is marked "separate"',
      'no disk has separate: true',
    );
  }

  need(
    ['0', '1', '2', '3', undefined].includes(env.HLCC_TRUST_PROXY),
    'HLCC_TRUST_PROXY is a small hop count',
    'must be 0-3',
  );
  if (env.HLCC_TRUST_PROXY === undefined)
    warn(
      G3,
      'HLCC_TRUST_PROXY is set explicitly',
      'defaults to 0; set 1 behind cloudflared so the real client address is used',
    );
  need(
    env.HLCC_PORT === undefined ||
      (/^\d+$/.test(env.HLCC_PORT) && Number(env.HLCC_PORT) >= 1 && Number(env.HLCC_PORT) <= 65535),
    'HLCC_PORT is a valid port',
    'not 1-65535',
  );
  if (env.HLCC_HOST_PROC_ASSERT === 'true')
    warn(
      G3,
      'Host-metric assertion is on',
      '/proc will be labelled operator-asserted; leave off unless the cross-check cannot work',
    );
  if (env.HLCC_MODE === 'mock')
    fail(G3, 'Production runs in live mode', 'HLCC_MODE=mock would show demo data');
  if (env.HLCC_ALLOW_INSECURE_COOKIES === 'true')
    warn(G3, 'Insecure cookies are allowed', 'only acceptable for plain-http testing');
  if (env.HLCC_NETDATA_URL) {
    try {
      const { validateTarget } = await import(
        pathToFileURL(join(root, 'apps/api/src/security/ssrf.ts')).href
      );
      need(
        validateTarget(env.HLCC_NETDATA_URL, true).ok,
        'HLCC_NETDATA_URL is an acceptable target',
        'blocked address, port or credentials',
      );
    } catch {
      /* checked by the config loader below */
    }
  }
}

// ---- not run here: what the engine and the server still have to prove ------------------------
const G4 = 'requires-docker-engine';
todo(
  G4,
  'Both images build',
  'docker compose -f deploy/compose.yaml build   (also: --target api, --target proxy)',
);
todo(
  G4,
  'The stack starts and both containers report healthy',
  'docker compose ... up -d && docker compose ... ps',
);
todo(
  G4,
  'The proxy refuses unauthenticated and mutating requests',
  'from inside the API container: GET /info without a token -> 401; POST -> 401/405',
);
todo(
  G4,
  'The API container has no socket and runs as a non-root user',
  'docker inspect <api> --format "{{.Mounts}} {{.Config.User}}"',
);
todo(
  G4,
  'Data survives a restart',
  'docker compose ... restart && check the dashboard still has its account and history',
);
todo(G4, 'Idle memory is within the limit', 'docker stats --no-stream');
const G5 = 'requires-ubuntu-host';
todo(G5, 'DOCKER_GID is the real docker group id', 'getent group docker | cut -d: -f3');
todo(
  G5,
  '/srv/storage is a mounted, separate filesystem',
  'findmnt /srv/storage ; df -h / /srv/storage ; lsblk -f',
);
todo(
  G5,
  'The probe directories exist and are owned by the container user (uid 1000)',
  'ls -ld <probe dirs> ; stat -c "%U %a" <secret files>',
);
todo(G5, 'Port 8787 is free and nothing else binds the same address', 'ss -ltnp | grep 8787');
todo(
  G5,
  "/proc cross-checks against the server's Docker daemon",
  'read the dashboard Host card: expect "cross-checked against the Docker daemon"',
);
todo(
  G5,
  'Netdata is not reachable from untrusted networks (if used)',
  'ss -ltnp | grep 19999 ; review its bind address and access list',
);
todo(
  G5,
  'Cloudflare Access / tunnel route for the new hostname',
  'review in the Cloudflare dashboard before adding any route',
);
todo(
  G5,
  'A backup of the database directory exists and a restore was rehearsed',
  'see docs/backup-and-recovery.md',
);

// ---- report -----------------------------------------------------------------------------------
const order = [G1, G2, G3, G4, G5];
const label = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', todo: 'TODO' };
if (asJson) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  for (const g of order) {
    const rows = results.filter((r) => r.group === g);
    if (!rows.length) continue;
    console.log(`\n== ${g} ==`);
    for (const r of rows)
      console.log(`  [${label[r.status]}] ${r.title}${r.detail ? `  (${r.detail})` : ''}`);
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `\n${n('pass')} passed, ${n('fail')} failed, ${n('warn')} warnings, ${n('todo')} still to verify on the engine or the server`,
  );
  if (n('fail')) console.log('Not ready: fix the failures above before a deployment review.');
  else
    console.log(
      'No blocking failures. The TODO items still need the Docker engine or the Ubuntu host.',
    );
}
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
