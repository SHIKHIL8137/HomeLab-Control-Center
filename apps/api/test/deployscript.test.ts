import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/hlcc-deploy.sh', import.meta.url)).replace(
  /\\/g,
  '/',
);
const posix = (p: string) => p.replace(/\\/g, '/');
const hasTools = ['flock', 'df', 'sha256sum', 'git', 'tar', 'python3', 'realpath', 'stat'].every(
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
      *" up "*)
        if [ -f "$STUB_ROOT/.deploy-in-progress" ]; then
          echo "MARKER_AT_UP" >> "$STUB_LOG"
          cp "$STUB_ROOT/.deploy-in-progress" "$STUB_STATE/marker.copy"
          stat -c %a "$STUB_ROOT/.deploy-in-progress" > "$STUB_STATE/marker.mode"
        fi
        [ -n "\${STUB_SLEEP_UP:-}" ] && sleep "$STUB_SLEEP_UP"
        exit 0;;
      *" build"*)
        echo "PARALLEL=$COMPOSE_PARALLEL_LIMIT" >> "$STUB_LOG"
        [ "\${STUB_KILL_ON_BUILD:-0}" = 1 ] && kill -9 $PPID
        exit 0;;
    esac; exit 0;;
  exec)
    case "$*" in
      *VACUUM*) echo db > "$STUB_DATA/backup-pre-$STUB_SHA7.db"; exit 0;;
      *"test ! -e"*) [ "\${STUB_SOCKET:-0}" = 1 ] && exit 1; exit 0;;
    esac; exit 0;;
  run) echo "\${STUB_INTEGRITY:-ok}"; exit 0;;
  ps) echo "container: homelab-control-center-hlcc-1 | Up 3 hours (healthy)"; exit 0;;
esac
exit 0
`,
  curl: `#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
case "$*" in *'%{http_code}'*) printf '%s' "\${STUB_UNAUTH_CODE:-401}";; esac
exit 0
`,
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

// A tiny tar writer so tests can build archives that `git archive` never would.
type TarEntry = { name: string; data?: Buffer | string; type?: string; link?: string };
function tarBytes(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    h.write(e.link ?? '', 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

type Ctx = {
  home: string;
  root: string;
  data: string;
  backups: string;
  stubs: string;
  state: string;
  log: string;
  envPath: string;
};
type Opts = {
  request?: string;
  tar?: Buffer;
  running?: boolean;
  previous?: string;
  load?: string;
  memKb?: number;
  tunnel?: boolean;
  stub?: Record<string, string>;
  env?: Record<string, string>;
  envFile?: (c: Ctx) => string; // replaces the env file's content
  setup?: (c: Ctx) => void; // runs after the directories exist, before the script
  ctx?: Ctx; // reuse an earlier run's directories
};

function prepare(rel: ReturnType<typeof makeRelease>, o: Opts) {
  let c = o.ctx;
  if (!c) {
    const home = tmp('home');
    const stubs = tmp('stubs');
    const state = tmp('state');
    c = {
      home,
      root: tmp('root'),
      data: tmp('data'),
      backups: tmp('bak'),
      stubs,
      state,
      log: join(state, 'calls.log'),
      envPath: join(home, 'hlcc.env'),
    };
    for (const [n, body] of Object.entries(STUBS)) {
      writeFileSync(join(stubs, n), body);
      chmodSync(join(stubs, n), 0o755);
    }
    // A release that is already running from the legacy top-level directory.
    mkdirSync(join(c.root, 'deploy'), { recursive: true });
    writeFileSync(join(c.root, 'deploy', 'compose.yaml'), 'name: old\n');
    if (o.previous) writeFileSync(join(c.root, '.deployed-sha'), `${o.previous}\n`);
    writeFileSync(
      c.envPath,
      o.envFile?.(c) ??
        `HLCC_DATA_PATH=${posix(c.data)}\nHLCC_PORT=8787\nHLCC_SECRET_PROBE=sekrit-value-9f3a\n${o.tunnel ? 'HLCC_TUNNEL_NETWORK=true\n' : ''}`,
    );
    chmodSync(c.envPath, 0o600);
    o.setup?.(c);
  }
  writeFileSync(c.log, '');
  const loadFile = join(c.state, 'loadavg');
  writeFileSync(loadFile, `${o.load ?? '0.10'} 0.1 0.1 1/1 1\n`);
  const memFile = join(c.state, 'meminfo');
  writeFileSync(memFile, `MemTotal: 8000000 kB\nMemAvailable: ${o.memKb ?? 6000000} kB\n`);
  const env = {
    ...process.env,
    PATH: `${posix(c.stubs)}:${process.env.PATH}`,
    HOME: posix(c.home),
    HLCC_HOME: posix(c.home),
    HLCC_ROOT: posix(c.root),
    HLCC_BACKUP_DIR: posix(c.backups),
    HLCC_BACKUP_MOUNT: '', // tests only: the path checks for it have their own tests
    HLCC_ENV_FILE: posix(c.envPath),
    HLCC_LOADAVG_FILE: posix(loadFile),
    HLCC_MEMINFO_FILE: posix(memFile),
    HLCC_MIN_FREE_MB: '1',
    HLCC_HEALTH_TIMEOUT: '1',
    HLCC_HEALTH_POLL: '0.2',
    SSH_ORIGINAL_COMMAND: o.request ?? `deploy ${rel.sha} ${rel.tree}`,
    SSH_CONNECTION: '100.100.1.2 54321 100.88.33.71 22',
    STUB_LOG: posix(c.log),
    STUB_DATA: posix(c.data),
    STUB_ROOT: posix(c.root),
    STUB_STATE: posix(c.state),
    STUB_SHA7: rel.sha.slice(0, 7),
    STUB_RUNNING: o.running ? '1' : '0',
    STUB_UNHEALTHY_MARKER: '@@never@@', // healthy unless a test names a path that should be unhealthy
    ...(o.stub ?? {}),
    ...(o.env ?? {}),
  };
  return { c, env, input: o.tar ?? rel.tar };
}

function summarize(c: Ctx, status: number | null, out: string) {
  const calls = readFileSync(c.log, 'utf8').split('\n').filter(Boolean);
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);
  return {
    status,
    out,
    calls,
    idx: (re: RegExp) => calls.findIndex((l) => re.test(l)),
    deployed: read(join(c.root, '.deployed-sha')),
    marker: existsSync(join(c.root, '.deploy-in-progress')),
    markerCopy: read(join(c.state, 'marker.copy')),
    markerMode: read(join(c.state, 'marker.mode')),
    releases: existsSync(join(c.root, 'releases')) ? readdirSync(join(c.root, 'releases')) : [],
    backups: readdirSync(c.backups),
    backupFile: (d: string) => join(c.backups, d, 'hlcc.db'),
    data: c.data,
    ctx: c,
    deployLog: read(join(c.home, 'deploy.log')) ?? '',
  };
}

function deploy(rel: ReturnType<typeof makeRelease>, o: Opts = {}) {
  const { c, env, input } = prepare(rel, o);
  const r = spawnSync('bash', [SCRIPT], { input, encoding: 'utf8', maxBuffer: 1 << 26, env });
  return summarize(c, r.status, `${r.stdout}${r.stderr}`);
}

/** Runs the script with a hook on the live child, for signal and broken-pipe behaviour. */
function deployAsync(
  rel: ReturnType<typeof makeRelease>,
  o: Opts,
  hook: (child: ReturnType<typeof spawn>) => void,
) {
  const { c, env, input } = prepare(rel, o);
  return new Promise<ReturnType<typeof summarize>>((resolve) => {
    const child = spawn('bash', [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    child.stdin!.end(input);
    hook(child);
    child.on('close', (code) => {
      // tee may still be flushing the log for a moment after the script exits
      setTimeout(() => resolve(summarize(c, code, out)), 400);
    });
  });
}

describe.skipIf(!hasTools)('hlcc-deploy.sh', () => {
  const rel = makeRelease();

  describe('the request', () => {
    it('refuses anything that is not exactly "check" or "deploy <commit> <tree>"', () => {
      for (const request of [
        '',
        'status',
        'deploy',
        `deploy ${rel.sha}`,
        `deploy ${rel.sha} ${rel.tree} extra`,
        `deploy ${rel.sha.slice(0, 39)} ${rel.tree}`,
        `deploy ${rel.sha.toUpperCase()} ${rel.tree}`,
        `deploy ${rel.sha}; rm -rf / ${rel.tree}`,
        `deploy $(id) ${rel.tree}`,
        'check extra',
        'check --all',
        'CHECK',
        'check;id',
        'check && id',
        '/bin/sh',
        'bash -c id',
      ]) {
        const r = deploy(rel, { request });
        expect(r.status, request).toBe(2);
        expect(r.calls, request).toEqual([]);
        expect(r.releases, request).toEqual([]);
      }
    });
  });

  describe('check (read-only diagnostics)', () => {
    const r = deploy(rel, { request: 'check', running: true, previous: 'e'.repeat(40) });

    it('reports readiness without changing anything', () => {
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/script sha256: [0-9a-f]{64}/);
      expect(r.out).toMatch(/source address: 100\.100\.1\.2 \(inside 100\.64\.0\.0\/10: yes\)/);
      expect(r.out).toMatch(/load: 0\.10/);
      expect(r.out).toMatch(/memory available MB: 5859/);
      expect(r.out).toMatch(/docker=yes .*flock=yes/);
      expect(r.out).toMatch(/configuration: ok/);
      expect(r.out).toContain(`deployed commit: ${'e'.repeat(40)}`);
      expect(r.out).toMatch(/no unfinished deploy marker/);
      expect(r.out).toMatch(/container: homelab-control-center-hlcc-1 \| Up 3 hours \(healthy\)/);
    });

    it('makes no service change and creates no files', () => {
      expect(r.calls.every((c) => c.startsWith('docker ps '))).toBe(true);
      expect(r.releases).toEqual([]); // not even the releases directory
      expect(r.backups).toEqual([]);
      expect(readdirSync(r.ctx.home).sort()).toEqual(['hlcc.env']);
      expect(readdirSync(r.ctx.root).sort()).toEqual(['.deployed-sha', 'deploy']);
    });

    it('never prints values from the environment file', () => {
      expect(r.out).not.toContain('sekrit-value-9f3a');
    });

    it('sanitises the source address and recognises addresses outside the tailnet range', () => {
      const outside = deploy(rel, { request: 'check', env: { SSH_CONNECTION: '8.8.8.8 1 2 3' } });
      expect(outside.out).toMatch(/source address: 8\.8\.8\.8 \(inside 100\.64\.0\.0\/10: no\)/);
      for (const junk of [
        '<script>alert(1)</script> 1 2 3',
        '',
        '$(id) 1 2 3',
        `${'a'.repeat(80)} 1 2 3`,
      ]) {
        const x = deploy(rel, { request: 'check', env: { SSH_CONNECTION: junk } });
        expect(x.out, junk).toMatch(/source address: \(invalid or absent\)/);
        expect(x.out, junk).not.toContain('<script>');
      }
      for (const edge of ['100.63.255.255 1 2 3', '100.128.0.1 1 2 3']) {
        expect(deploy(rel, { request: 'check', env: { SSH_CONNECTION: edge } }).out).toMatch(
          /: no\)/,
        );
      }
    });

    it('reports configuration problems and an unfinished marker instead of failing', () => {
      const bad = deploy(rel, {
        request: 'check',
        setup: (c) => writeFileSync(join(c.root, '.deploy-in-progress'), 'commit=abc\nstarted=x\n'),
        envFile: () => 'HLCC_DATA_PATH=relative/path\n',
      });
      expect(bad.status).toBe(0);
      expect(bad.out).toMatch(/configuration problems:/);
      expect(bad.out).toMatch(/HLCC_DATA_PATH is not an absolute path/);
      expect(bad.out).toMatch(/UNFINISHED DEPLOY MARKER PRESENT/);
      expect(bad.out).toContain('commit=abc');
    });
  });

  describe('configuration is validated before anything changes', () => {
    const expectRefused = (r: ReturnType<typeof deploy>, phrase: RegExp) => {
      expect(r.status, r.out).toBe(2);
      expect(r.out).toMatch(phrase);
      expect(r.calls).toEqual([]);
      expect(r.releases).toEqual([]);
      expect(r.out).not.toContain('sekrit-value-9f3a');
    };
    const env = (data: string, extra = '') =>
      `HLCC_DATA_PATH=${data}\nHLCC_SECRET_PROBE=sekrit-value-9f3a\n${extra}`;

    it('rejects an empty, relative, missing, odd or traversing data path', () => {
      expectRefused(deploy(rel, { envFile: () => env('') }), /HLCC_DATA_PATH is empty/);
      expectRefused(deploy(rel, { envFile: () => env('relative/dir') }), /not an absolute path/);
      expectRefused(
        deploy(rel, { envFile: () => env('/nonexistent-hlcc-test-dir') }),
        /not an existing directory/,
      );
      expectRefused(
        deploy(rel, { envFile: () => env('/tmp/a b') }),
        /not an absolute path of plain characters/,
      );
      expectRefused(
        deploy(rel, { envFile: (c) => env(`${posix(c.data)}/../${c.data.split(/[\\/]/).pop()}`) }),
        /empty, \. or \.\. component/,
      );
    });

    it('rejects a symlinked or shared data directory', () => {
      expectRefused(
        deploy(rel, {
          setup: (c) => symlinkSync(c.data, join(c.state, 'link')),
          envFile: (c) => env(posix(join(c.state, 'link'))),
        }),
        /HLCC_DATA_PATH is a symlink/,
      );
      expectRefused(
        deploy(rel, { setup: (c) => chmodSync(c.data, 0o770) }),
        /HLCC_DATA_PATH is writable by group or others/,
      );
    });

    it('rejects data inside the release directory and duplicate keys', () => {
      expectRefused(
        deploy(rel, {
          setup: (c) => mkdirSync(join(c.root, 'data'), { mode: 0o700 }),
          envFile: (c) => env(posix(join(c.root, 'data'))),
        }),
        /HLCC_DATA_PATH is inside the release directory/,
      );
      expectRefused(
        deploy(rel, { envFile: (c) => env(posix(c.data), `HLCC_DATA_PATH=${posix(c.data)}\n`) }),
        /HLCC_DATA_PATH is set more than once/,
      );
    });

    it('rejects an env file that others can read, an env symlink and a bad port', () => {
      expectRefused(
        deploy(rel, { setup: (c) => chmodSync(c.envPath, 0o640) }),
        /env file is readable by group or others/,
      );
      expectRefused(
        deploy(rel, {
          setup: (c) => {
            rmSync(c.envPath);
            writeFileSync(join(c.state, 'real.env'), env(posix(c.data)), { mode: 0o600 });
            symlinkSync(join(c.state, 'real.env'), c.envPath);
          },
        }),
        /env file is missing or is a symlink/,
      );
      expectRefused(
        deploy(rel, { envFile: (c) => env(posix(c.data), 'HLCC_PORT=99999\n') }),
        /HLCC_PORT is not a valid port/,
      );
    });

    it('requires the backup directory to sit on a real mount point', () => {
      expectRefused(
        deploy(rel, { env: { HLCC_BACKUP_MOUNT: tmp('notmount') } }),
        /is not a mount point/,
      );
      expectRefused(
        deploy(rel, { env: { HLCC_BACKUP_MOUNT: '/dev/shm' } }),
        /HLCC_BACKUP_DIR is not inside the backup mount/,
      );
    });

    it('requires the backup directory to be a plain, private directory', () => {
      expectRefused(
        deploy(rel, { setup: (c) => chmodSync(c.backups, 0o777) }),
        /HLCC_BACKUP_DIR is writable by group or others/,
      );
      expectRefused(
        deploy(rel, { env: { HLCC_BACKUP_DIR: '/nonexistent-hlcc-backups' } }),
        /HLCC_BACKUP_DIR is not an existing directory/,
      );
    });
  });

  describe('release archives are validated before anything is extracted', () => {
    const base: TarEntry[] = [
      { name: 'deploy/', type: '5' },
      { name: 'deploy/compose.yaml', data: 'name: x\n' },
    ];
    const rejects = (entries: TarEntry[], reason: RegExp, o: Opts = {}) => {
      const r = deploy(rel, { tar: tarBytes(entries), ...o });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(reason);
      expect(r.calls).toEqual([]);
      expect(r.releases).toEqual([]); // staging and the archive copy are cleaned up
      expect(r.deployed).toBeNull();
    };

    it('lets a plain, well-formed archive through to the tree check', () => {
      const r = deploy(rel, { tar: tarBytes(base) });
      expect(r.out).toMatch(/tree mismatch/); // it passed validation and extraction, then failed the hash
    });

    it('rejects path traversal and absolute paths', () => {
      rejects([...base, { name: '../evil.txt', data: 'x' }], /unsafe archive path/);
      rejects([...base, { name: 'a/../../evil.txt', data: 'x' }], /unsafe archive path/);
      rejects([...base, { name: '/etc/evil.txt', data: 'x' }], /unsafe archive path/);
      rejects([...base, { name: './deploy/x', data: 'x' }], /unsafe archive path/);
      rejects([...base, { name: 'a//b', data: 'x' }], /unsafe archive path/);
      rejects([...base, { name: 'win\\path.txt', data: 'x' }], /unsafe archive path/);
    });

    it('rejects duplicate entries', () => {
      rejects(
        [...base, { name: 'deploy/compose.yaml', data: 'name: other\n' }],
        /duplicate archive path/,
      );
    });

    it('rejects symlinks, hard links and special files', () => {
      rejects(
        [...base, { name: 'link', type: '2', link: '/etc/passwd' }],
        /symlink, hard link, or special file/,
      );
      rejects(
        [...base, { name: 'hard', type: '1', link: 'deploy/compose.yaml' }],
        /symlink, hard link, or special file/,
      );
      rejects([...base, { name: 'dev', type: '3' }], /symlink, hard link, or special file/);
      rejects([...base, { name: 'pipe', type: '6' }], /symlink, hard link, or special file/);
    });

    it('rejects compressed archives, truncated archives and garbage', () => {
      const plain = tarBytes(base);
      rejects([], /invalid release archive/, { tar: gzipSync(plain) });
      rejects([], /invalid release archive/, { tar: plain.subarray(0, 700) });
      rejects([], /invalid release archive/, {
        tar: Buffer.from('not a tar file at all'.repeat(100)),
      });
    });

    it('enforces the size, expansion and entry limits', () => {
      rejects([], /exceeds the size limit/, {
        tar: rel.tar,
        env: { HLCC_MAX_ARCHIVE_BYTES: '1000' },
      });
      rejects(
        [...base, { name: 'big.bin', data: Buffer.alloc(2000) }],
        /expanded release exceeds/,
        {
          env: { HLCC_MAX_EXPANDED_BYTES: '100' },
        },
      );
      rejects(
        [...base, { name: 'a', data: '1' }, { name: 'b', data: '2' }, { name: 'c', data: '3' }],
        /too many archive entries/,
        { env: { HLCC_MAX_ENTRIES: '3' } },
      );
    });

    it('writes nothing outside staging even when a later entry is bad', () => {
      const marker = join(tmp('outside'), 'evil.txt');
      rejects([...base, { name: posix(marker), data: 'x' }], /unsafe archive path/);
      expect(existsSync(marker)).toBe(false);
    });

    it('refuses files that do not hash to the tree CI built, and a release with no Compose file', () => {
      const r = deploy(rel, { request: `deploy ${rel.sha} ${'0'.repeat(40)}` });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/tree mismatch/);
      expect(r.calls).toEqual([]);
      expect(r.releases).toEqual([]);
      const bare = makeRelease((repo) => rmSync(join(repo, 'deploy', 'compose.yaml')));
      const x = deploy(bare);
      expect(x.status).toBe(1);
      expect(x.out).toMatch(/no deploy\/compose\.yaml/);
      expect(x.calls).toEqual([]);
    });
  });

  describe('the server must have room', () => {
    it('does not deploy while the server is busy', () => {
      const r = deploy(rel, { load: '9.00', running: true });
      expect(r.status).toBe(75);
      expect(r.out).toMatch(/server busy/);
      expect(r.calls.filter((c) => / (build|up) /.test(c))).toEqual([]);
      expect(r.deployed).toBeNull();
      expect(r.marker).toBe(false);
    });

    it('does not deploy when memory is short', () => {
      const r = deploy(rel, { memKb: 400_000, running: true });
      expect(r.status).toBe(75);
      expect(r.out).toMatch(/MB of memory available/);
      expect(r.calls.filter((c) => / (build|up) /.test(c))).toEqual([]);
      expect(r.marker).toBe(false);
    });

    it('is a no-op when that commit is already deployed', () => {
      const r = deploy(rel, { previous: rel.sha, running: true });
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/already deployed/);
      expect(r.calls).toEqual([]);
    });
  });

  describe('a normal deploy', () => {
    const r = deploy(rel, { running: true, previous: 'a'.repeat(40) });

    it('succeeds, records the commit and leaves no marker behind', () => {
      expect(r.status, r.out).toBe(0);
      expect(r.deployed).toBe(rel.sha);
      expect(r.releases).toEqual([rel.sha]);
      expect(r.out).toMatch(/DONE/);
      expect(r.marker).toBe(false);
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

    it('writes a private in-progress marker before services change, and builds one image at a time', () => {
      expect(r.calls).toContain('MARKER_AT_UP');
      expect(r.markerMode).toBe('600');
      expect(r.markerCopy).toContain(`commit=${rel.sha}`);
      expect(r.markerCopy).toContain(`tree=${rel.tree}`);
      expect(r.markerCopy).toMatch(/started=\d{4}-\d\d-\d\dT/);
      expect(r.markerCopy).toContain(`previous=${'a'.repeat(40)}`);
      expect(r.calls).toContain('PARALLEL=1');
      expect(r.idx(/^PARALLEL=1$/)).toBeGreaterThan(-1);
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

  it('stops before changing services when the backup fails its integrity check', () => {
    const r = deploy(rel, {
      running: true,
      previous: 'b'.repeat(40),
      stub: { STUB_INTEGRITY: 'database disk image is malformed' },
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/integrity/);
    expect(r.calls.filter((c) => / (build|up) /.test(c) || c.startsWith('docker tag'))).toEqual([]);
    expect(r.deployed).toBe('b'.repeat(40));
    expect(r.marker).toBe(false); // nothing had changed yet, so there is nothing to reconcile
  });

  describe('automatic rollback', () => {
    const prev = 'c'.repeat(40);
    const check = (r: ReturnType<typeof deploy>) => {
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/ROLLED BACK/);
      expect(r.deployed).toBe(prev); // the failed commit is never recorded as live
      expect(r.marker).toBe(false); // cleared only because the previous version is verified healthy
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
      check(deploy(rel, { running: true, previous: prev, stub: { STUB_UNAUTH_CODE: '200' } }));
    });
    it('when the API container can see the Docker socket', () => {
      check(deploy(rel, { running: true, previous: prev, stub: { STUB_SOCKET: '1' } }));
    });

    it('keeps the marker when the rollback itself cannot be verified', () => {
      const r = deploy(rel, {
        running: true,
        previous: prev,
        stub: { STUB_UNHEALTHY_MARKER: 'deploy/compose.yaml' },
      });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/ROLLBACK DID NOT COMPLETE/);
      expect(r.marker).toBe(true);
      expect(r.deployed).toBe(prev);
    });

    it('uses a compatible tunnel override even when the old release has none', () => {
      const r = deploy(rel, {
        running: true,
        previous: prev,
        tunnel: true,
        stub: { STUB_UNHEALTHY_MARKER: `releases/${rel.sha}/deploy/compose.yaml` },
      });
      const ups = r.calls.filter((c) => / up -d --no-build$/.test(c));
      expect(ups).toHaveLength(2);
      // The rollback runs the old Compose file (the legacy top-level copy) ...
      expect(ups[1]).toMatch(
        new RegExp(`-f \\S*${r.ctx.root.split(/[\\/]/).pop()}/deploy/compose\\.yaml`),
      );
      expect(ups[1]).not.toContain(`releases/${rel.sha}/deploy/compose.yaml`);
      // ... with the newest copy of the override, so the dashboard keeps its tunnel network.
      expect(ups[1]).toContain(`releases/${rel.sha}/deploy/compose.tunnel.yaml`);
      expect(r.out).toMatch(/ROLLED BACK/);
    });
  });

  describe('interrupted deployments', () => {
    it('leaves the marker and the old commit in place after a hard kill, then refuses to run until reconciled', () => {
      const prev = 'd'.repeat(40);
      const first = deploy(rel, {
        running: true,
        previous: prev,
        stub: { STUB_KILL_ON_BUILD: '1' },
      });
      expect(first.status).not.toBe(0); // killed with SIGKILL: no trap ran, as in a power loss
      expect(first.marker).toBe(true);
      expect(first.deployed).toBe(prev); // never marked successful

      const second = deploy(rel, { ctx: first.ctx });
      expect(second.status).toBe(78);
      expect(second.out).toMatch(/REFUSING: an earlier deploy did not finish/);
      expect(second.out).toContain(`commit=${rel.sha}`);
      expect(second.out).toMatch(/delete .*\.deploy-in-progress to continue/);
      expect(second.calls).toEqual([]); // nothing was touched
      expect(second.marker).toBe(true);

      rmSync(join(first.ctx.root, '.deploy-in-progress')); // the administrator reconciles, then clears it
      const third = deploy(rel, { ctx: first.ctx });
      expect(third.status, third.out).toBe(0);
      expect(third.deployed).toBe(rel.sha);
      expect(third.marker).toBe(false);
    });

    it('cleans staging and the archive copy after a failed run', () => {
      const r = deploy(rel, {
        stub: { STUB_UNAUTH_CODE: '200' },
        running: true,
        previous: 'f'.repeat(40),
      });
      expect(r.releases.filter((n) => n.startsWith('.incoming'))).toEqual([]);
    });

    it('keeps deploying through a SIGHUP, as when the SSH connection drops', async () => {
      const r = await deployAsync(
        rel,
        { running: true, previous: 'a'.repeat(40), stub: { STUB_SLEEP_UP: '2' } },
        (child) => setTimeout(() => child.kill('SIGHUP'), 700),
      );
      expect(r.status, r.out).toBe(0);
      expect(r.deployed).toBe(rel.sha);
      expect(r.marker).toBe(false);
      expect(r.deployLog).toMatch(/DONE/);
    }, 30_000);

    it('finishes a deploy after the output pipes are closed, and logs it', async () => {
      const r = await deployAsync(rel, { running: true, previous: 'a'.repeat(40) }, (child) => {
        child.stdout!.destroy();
        child.stderr!.destroy();
      });
      expect(r.status).toBe(0);
      expect(r.deployed).toBe(rel.sha);
      expect(r.deployLog).toMatch(/DONE/);
    }, 30_000);

    it('completes a rollback after the output pipes are closed', async () => {
      const prev = 'a'.repeat(40);
      const r = await deployAsync(
        rel,
        { running: true, previous: prev, stub: { STUB_UNHEALTHY_MARKER: `releases/${rel.sha}` } },
        (child) => {
          child.stdout!.destroy();
          child.stderr!.destroy();
        },
      );
      expect(r.status).toBe(1);
      expect(r.deployLog).toMatch(/ROLLED BACK/);
      expect(r.deployed).toBe(prev);
      expect(r.marker).toBe(false);
    }, 30_000);
  });
});
