import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/hlcc-deploy.sh', import.meta.url)).replace(
  /\\/g,
  '/',
);
const posix = (p: string) => p.replace(/\\/g, '/');
const hasTools = ['flock', 'df', 'sha256sum', 'git', 'tar'].every(
  (c) => spawnSync('bash', ['-c', `command -v ${c}`]).status === 0,
);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `hlcc-${p}-`));

// Recording stand-ins: nothing here can touch a real Docker, and the log shows every call made.
const STUBS: Record<string, string> = {
  docker: `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1" in
  compose)
    case "$*" in
      *" ps -q hlcc"*) [ "\${STUB_RUNNING:-0}" = 1 ] && echo cid123; exit 0;;
      *"ps --format"*)
        case "$*" in
          *"\${STUB_UNHEALTHY_MARKER:-@@none@@}"*) printf 'hlcc starting\\ndocker-proxy healthy\\n';;
          *) printf 'hlcc healthy\\ndocker-proxy healthy\\n';;
        esac; exit 0;;
    esac; exit 0;;
  exec)
    case "$*" in
      *VACUUM*) echo db > "$STUB_DATA/backup-pre-$STUB_SHA7.db"; exit 0;;
      *"test ! -e"*) [ "\${STUB_SOCKET:-0}" = 1 ] && exit 1; exit 0;;
    esac; exit 0;;
  run) echo "\${STUB_INTEGRITY:-ok}"; exit 0;;
esac
exit 0
`,
  curl: `#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
case "$*" in *'%{http_code}'*) printf '%s' "\${STUB_UNAUTH_CODE:-401}";; esac
exit 0
`,
  nice: '#!/bin/sh\nshift 2\nexec "$@"\n',
  ionice: '#!/bin/sh\nshift 1\nexec "$@"\n',
};

function makeRelease(extra: (repo: string) => void = () => {}) {
  const repo = tmp('rel');
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  mkdirSync(join(repo, 'deploy'));
  writeFileSync(join(repo, 'deploy', 'compose.yaml'), 'name: x\n');
  writeFileSync(join(repo, 'deploy', 'compose.tunnel.yaml'), 'services: {}\n');
  writeFileSync(join(repo, 'hello.txt'), 'hello\n');
  extra(repo);
  git('add', '-A');
  git('commit', '-q', '-m', 'r');
  const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: repo,
    maxBuffer: 1 << 26,
  });
  return { tar, sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

type Opts = {
  request?: string;
  tar?: Buffer;
  running?: boolean;
  previous?: string;
  load?: string;
  tunnel?: boolean;
  stub?: Record<string, string>;
};

function deploy(rel: ReturnType<typeof makeRelease>, o: Opts = {}) {
  const home = tmp('home');
  const root = tmp('root');
  const data = tmp('data');
  const backups = tmp('bak');
  const stubs = tmp('stubs');
  const state = tmp('state');
  const log = join(state, 'calls.log');
  writeFileSync(log, '');
  for (const [n, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, n), body);
    chmodSync(join(stubs, n), 0o755);
  }
  // A release that is already running from the legacy top-level directory.
  mkdirSync(join(root, 'deploy'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'compose.yaml'), 'name: old\n');
  if (o.previous) writeFileSync(join(root, '.deployed-sha'), `${o.previous}\n`);
  writeFileSync(
    join(home, 'hlcc.env'),
    `HLCC_DATA_PATH=${posix(data)}\nHLCC_PORT=8787\n${o.tunnel ? 'HLCC_TUNNEL_NETWORK=true\n' : ''}`,
  );
  const loadFile = join(state, 'loadavg');
  writeFileSync(loadFile, `${o.load ?? '0.10'} 0.1 0.1 1/1 1\n`);
  const r = spawnSync('bash', [SCRIPT], {
    input: o.tar ?? rel.tar,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    env: {
      ...process.env,
      PATH: `${posix(stubs)}:${process.env.PATH}`,
      HOME: posix(home),
      HLCC_HOME: posix(home),
      HLCC_ROOT: posix(root),
      HLCC_BACKUP_DIR: posix(backups),
      HLCC_BACKUP_MOUNT: '',
      HLCC_ENV_FILE: posix(join(home, 'hlcc.env')),
      HLCC_LOADAVG_FILE: posix(loadFile),
      HLCC_MIN_FREE_MB: '1',
      HLCC_HEALTH_TIMEOUT: '1',
      HLCC_HEALTH_POLL: '0.2',
      SSH_ORIGINAL_COMMAND: o.request ?? `deploy ${rel.sha} ${rel.tree}`,
      STUB_LOG: posix(log),
      STUB_DATA: posix(data),
      STUB_SHA7: rel.sha.slice(0, 7),
      STUB_RUNNING: o.running ? '1' : '0',
      STUB_UNHEALTHY_MARKER: '@@never@@', // healthy unless a test names a path that should be unhealthy
      ...Object.fromEntries(Object.entries(o.stub ?? {})),
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const idx = (re: RegExp) => calls.findIndex((c) => re.test(c));
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls,
    idx,
    deployed: existsSync(join(root, '.deployed-sha'))
      ? readFileSync(join(root, '.deployed-sha'), 'utf8').trim()
      : null,
    releases: existsSync(join(root, 'releases')) ? readdirSync(join(root, 'releases')) : [],
    backups: readdirSync(backups),
    backupFile: (d: string) => join(backups, d, 'hlcc.db'),
    data,
  };
}

describe.skipIf(!hasTools)('hlcc-deploy.sh', () => {
  const rel = makeRelease();

  it('refuses anything that is not exactly "deploy <commit> <tree>"', () => {
    for (const request of [
      '',
      'status',
      `deploy ${rel.sha}`,
      `deploy ${rel.sha} ${rel.tree} extra`,
      `deploy ${rel.sha.slice(0, 39)} ${rel.tree}`,
      `deploy ${rel.sha.toUpperCase()} ${rel.tree}`,
      `deploy ${rel.sha}; rm -rf / ${rel.tree}`,
      `deploy $(id) ${rel.tree}`,
    ]) {
      const r = deploy(rel, { request });
      expect(r.status, request).toBe(2);
      expect(r.calls, request).toEqual([]);
    }
  });

  it('refuses files that do not hash to the tree CI built, before touching Docker', () => {
    const r = deploy(rel, { request: `deploy ${rel.sha} ${'0'.repeat(40)}` });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/tree mismatch/);
    expect(r.calls).toEqual([]);
    expect(r.releases).toEqual([]);
    expect(r.deployed).toBeNull();
  });

  it('refuses a corrupt archive and a release with no Compose file', () => {
    const garbage = deploy(rel, { tar: Buffer.from('not a tar file at all'.repeat(100)) });
    expect(garbage.status).not.toBe(0);
    expect(garbage.calls).toEqual([]);
    const bare = makeRelease((repo) => rmSync(join(repo, 'deploy', 'compose.yaml')));
    const r = deploy(bare);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no deploy\/compose\.yaml/);
    expect(r.calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a release containing a symlink', () => {
    const bad = makeRelease((repo) => symlinkSync('/etc', join(repo, 'link')));
    const r = deploy(bad);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/symlink/);
    expect(r.calls).toEqual([]);
  });

  it('does not deploy while the server is busy', () => {
    const r = deploy(rel, { load: '9.00', running: true });
    expect(r.status).toBe(75);
    expect(r.out).toMatch(/server busy/);
    expect(r.calls.filter((c) => / (build|up) /.test(c))).toEqual([]);
    expect(r.deployed).toBeNull();
  });

  it('is a no-op when that commit is already deployed', () => {
    const r = deploy(rel, { previous: rel.sha, running: true });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/already deployed/);
    expect(r.calls).toEqual([]);
  });

  describe('a normal deploy', () => {
    const r = deploy(rel, { running: true, previous: 'a'.repeat(40) });

    it('succeeds and records the commit', () => {
      expect(r.status, r.out).toBe(0);
      expect(r.deployed).toBe(rel.sha);
      expect(r.releases).toEqual([rel.sha]);
      expect(r.out).toMatch(/DONE/);
    });

    it('backs up first, then tags the old images, builds, starts, and smoke-tests', () => {
      const order = [
        r.idx(/docker exec cid123 node -e .*VACUUM/),
        r.idx(/docker run /),
        r.idx(/docker tag homelab-control-center:local homelab-control-center:previous/),
        r.idx(/ build$/),
        r.idx(/ up -d --no-build$/),
        r.idx(/curl .*\/api\/v1\/health/),
        r.idx(/curl .*\/api\/v1\/overview/),
        r.idx(/docker exec cid123 sh -c test ! -e \/var\/run\/docker\.sock/),
      ];
      expect(
        order.every((i) => i >= 0),
        JSON.stringify(order),
      ).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('keeps a verified backup copy and leaves no temp file in the data directory', () => {
      expect(r.backups).toHaveLength(1);
      expect(existsSync(r.backupFile(r.backups[0]!))).toBe(true);
      expect(readdirSync(r.data)).toEqual([]);
    });

    it('only ever runs commands for its own project, and nothing destructive', () => {
      for (const c of r.calls.filter((x) => x.startsWith('docker compose')))
        expect(c).toContain('--project-name homelab-control-center');
      // The one `docker run` is the throwaway integrity check: read-only mount, removed afterwards.
      const runs = r.calls.filter((c) => c.startsWith('docker run '));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/--rm -v \S+:\/b:ro /);
      const forbidden =
        /\b(prune|rm|rmi|down|volume|system|network|stop|restart|kill)\b|^docker inspect/;
      expect(r.calls.filter((c) => !c.startsWith('docker run ') && forbidden.test(c))).toEqual([]);
    });
  });

  it('skips the backup on a machine with no running dashboard', () => {
    const r = deploy(rel, { running: false });
    expect(r.status, r.out).toBe(0);
    expect(r.backups).toEqual([]);
    expect(r.out).toMatch(/skipping the backup/);
  });

  it('adds the tunnel network file only when the env file asks for it', () => {
    const on = deploy(rel, { running: false, tunnel: true });
    const off = deploy(rel, { running: false });
    expect(on.calls.find((c) => / up -d /.test(c))).toContain('compose.tunnel.yaml');
    expect(off.calls.find((c) => / up -d /.test(c))).not.toContain('compose.tunnel.yaml');
  });

  it('stops before building when the backup fails its integrity check', () => {
    const r = deploy(rel, {
      running: true,
      previous: 'b'.repeat(40),
      stub: { STUB_INTEGRITY: 'database disk image is malformed' },
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/integrity/);
    expect(r.calls.filter((c) => / (build|up) /.test(c) || c.startsWith('docker tag'))).toEqual([]);
    expect(r.deployed).toBe('b'.repeat(40));
  });

  describe('automatic rollback', () => {
    const prev = 'c'.repeat(40);
    const check = (r: ReturnType<typeof deploy>) => {
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/ROLLED BACK/);
      expect(r.deployed).toBe(prev); // the failed commit is never recorded as live
      const retag = r.idx(
        /docker tag homelab-control-center:previous homelab-control-center:local/,
      );
      const ups = r.calls
        .map((c, i) => (/ up -d --no-build$/.test(c) ? i : -1))
        .filter((i) => i >= 0);
      expect(retag).toBeGreaterThan(-1);
      expect(ups).toHaveLength(2); // the failed release, then the previous one
      expect(ups[1]).toBeGreaterThan(retag);
      expect(r.calls[ups[1]!]).not.toContain(`releases/${rel.sha}`);
      expect(r.out).toMatch(/database backup from before this deploy/);
    };

    it('when the services never become healthy', () => {
      check(
        deploy(rel, {
          running: true,
          previous: prev,
          stub: { STUB_UNHEALTHY_MARKER: `releases/${rel.sha}` },
        }),
      );
    });
    it('when the unauthenticated check does not return 401', () => {
      check(
        deploy(rel, {
          running: true,
          previous: prev,
          stub: { STUB_UNHEALTHY_MARKER: '@@never@@', STUB_UNAUTH_CODE: '200' },
        }),
      );
    });
    it('when the API container can see the Docker socket', () => {
      check(
        deploy(rel, {
          running: true,
          previous: prev,
          stub: { STUB_UNHEALTHY_MARKER: '@@never@@', STUB_SOCKET: '1' },
        }),
      );
    });
  });
});
