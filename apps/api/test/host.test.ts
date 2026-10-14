import { describe, expect, it } from 'vitest';
import {
  createHostAdapter,
  parseMountInfo,
  type DiskConfig,
  type FsOps,
} from '../src/providers/host.ts';
import { ProviderUnavailableError } from '../src/providers/types.ts';

const GiB = 1024 ** 3;
const meminfo = (totalKb = 7340032, availKb = 6291456, swapFreeKb = 4000000) =>
  `MemTotal:       ${totalKb} kB\nMemFree:         4000000 kB\nMemAvailable:   ${availKb} kB\nSwapTotal:      4194304 kB\nSwapFree:       ${swapFreeKb} kB\n`;
const stat = (total: number, idle: number) =>
  `cpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\nbtime 1700000000\n`;

interface Sfs0 {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}
type Sfs = Sfs0;
interface FakeOpts {
  files?: Record<string, string | (() => string)>;
  statfs?: Record<string, Sfs>;
}

/** Files can be strings or functions, so successive reads of /proc/stat can differ. */
function fakeFs(o: FakeOpts): FsOps {
  return {
    async readText(p) {
      const v = o.files?.[p];
      return v === undefined ? null : typeof v === 'function' ? v() : v;
    },
    async statfs(p) {
      const s = o.statfs?.[p];
      if (!s) throw new Error('no statfs');
      return s;
    },
  };
}

/** One mountinfo line in the kernel's real format. */
const mnt = (id: number, dev: string, root: string, point: string, fs: string, src = '/dev/x') =>
  `${id} 1 ${dev} ${root} ${point} rw,relatime shared:1 - ${fs} ${src} rw`;
const mountinfo = (...lines: string[]) => `${lines.join('\n')}\n`;

const base = (extra: Record<string, string | (() => string)> = {}) => ({
  '/proc/meminfo': meminfo(),
  '/proc/uptime': '100000.50 90000.00\n',
  '/proc/stat': () => stat(1000, 800),
  '/proc/loadavg': '0.42 0.30 0.20 1/100 123\n',
  ...extra,
});

const daemonOk = async () => ({
  memTotalBytes: 7340032 * 1024,
  ncpu: 8,
  operatingSystem: 'Ubuntu 26.04 LTS',
  kernelVersion: '7.0.0-38-generic',
});

function adapter(
  files: FakeOpts['files'],
  over: Partial<Parameters<typeof createHostAdapter>[0]> = {},
  fsOver: Omit<FakeOpts, 'files'> = {},
) {
  return createHostAdapter({
    clock: () => Date.UTC(2026, 9, 14, 12),
    disks: [],
    daemon: daemonOk,
    processUptime: () => 10,
    fs: fakeFs({ files: files ?? base(), ...fsOver }),
    ...over,
  });
}

const refused = async (a: ReturnType<typeof adapter>, re: RegExp) => {
  const err = await a.read().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderUnavailableError);
  expect((err as Error).message).toMatch(re);
};

describe('host adapter: measurements', () => {
  it('reads memory, swap, load, uptime and boot time from /proc', async () => {
    const s = await adapter(base()).read();
    expect(s.memTotalBytes).toBe(7340032 * 1024);
    expect(s.memAvailableBytes).toBe(6291456 * 1024);
    expect(s.memUsedBytes).toBe(s.memTotalBytes - s.memAvailableBytes);
    expect(s.swapTotalBytes).toBe(4194304 * 1024);
    expect(s.swapUsedBytes).toBe((4194304 - 4000000) * 1024);
    expect(s.load1).toBe(0.42);
    expect(s.uptimeSeconds).toBe(100000);
    expect(Date.parse(s.bootTime)).toBe(Date.UTC(2026, 9, 14, 12) - 100000.5 * 1000);
    expect(s.collectedAt).toBe('2026-10-14T12:00:00.000Z');
    expect(s.method).toEqual({ kind: 'procfs', verification: 'docker-info-cross-check' });
    expect(s.memPressureAvg60).toBeNull(); // PSI file absent: unavailable, not zero
  });

  it('parses PSI memory pressure when present', async () => {
    const s = await adapter(
      base({
        '/proc/pressure/memory':
          'some avg10=0.00 avg60=2.35 avg300=1.00 total=123\nfull avg10=0.00 avg60=0.10 avg300=0.00 total=1\n',
      }),
    ).read();
    expect(s.memPressureAvg60).toBe(2.35);
  });

  it('tolerates a missing loadavg', async () => {
    const files = base();
    delete (files as Record<string, unknown>)['/proc/loadavg'];
    expect((await adapter(files).read()).load1).toBeNull();
  });
});

describe('host adapter: CPU is a rate, and says so when it cannot be one', () => {
  const sequence = (...reads: string[]) => {
    let i = 0;
    return () => reads[Math.min(i++, reads.length - 1)]!;
  };

  it('computes CPU from the change between two readings', async () => {
    const a = adapter(
      base({ '/proc/stat': sequence(stat(1000, 800), stat(1100, 860), stat(1200, 900)) }),
    );
    expect((await a.read()).cpuPercent).toBe(40); // first call: 100 ticks, 60 idle
    expect((await a.read()).cpuPercent).toBe(60); // then: 100 ticks, 40 idle
  });

  it('reports unknown, not 0%, when no ticks elapsed between readings', async () => {
    expect((await adapter(base()).read()).cpuPercent).toBeNull();
  });

  it('reports unknown when the counters went backwards, then recovers', async () => {
    const a = adapter(
      base({
        '/proc/stat': sequence(stat(1000, 800), stat(1100, 860), stat(500, 400), stat(600, 460)),
      }),
    );
    expect((await a.read()).cpuPercent).toBe(40);
    expect((await a.read()).cpuPercent).toBeNull(); // counter reset (e.g. VM migration)
    expect((await a.read()).cpuPercent).toBe(40); // baseline was re-established
  });

  it('reports unknown when idle time grew more than total time', async () => {
    const a = adapter(base({ '/proc/stat': sequence(stat(1000, 800), stat(1010, 900)) }));
    expect((await a.read()).cpuPercent).toBeNull();
  });
});

describe('host adapter: malformed or missing /proc', () => {
  it('fails clearly instead of reporting zeros', async () => {
    await refused(adapter(base({ '/proc/meminfo': 'garbage' })), /meminfo/);
    await refused(adapter(base({ '/proc/meminfo': 'MemTotal: 100 kB\n' })), /MemAvailable/);
    await refused(adapter(base({ '/proc/uptime': 'soon' })), /uptime/);
    await refused(adapter(base({ '/proc/uptime': '-5 1' })), /uptime/);
    await refused(adapter(base({ '/proc/stat': 'cpu a b c' })), /stat/);
    await refused(adapter(base({ '/proc/stat': 'cpu 1 2 3 4 5 6 7 -8' })), /stat/);
    const noStat = base();
    delete (noStat as Record<string, unknown>)['/proc/stat'];
    await refused(adapter(noStat), /Cannot read/);
  });

  it('refuses values that cannot be true', async () => {
    await refused(adapter(base({ '/proc/meminfo': meminfo(1000, 2000) })), /inconsistent/);
    await refused(
      adapter(base({ '/proc/meminfo': meminfo(7340032, 6291456, 9_999_999) })),
      /inconsistent/,
    );
    await refused(adapter(base({ '/proc/meminfo': meminfo(0, 0) })), /inconsistent/);
  });
});

describe('host adapter: is /proc really the host?', () => {
  it('refuses when /proc/meminfo equals the container memory limit (virtualised /proc)', async () => {
    await refused(
      adapter(
        base({
          '/proc/meminfo': meminfo(262144, 100000),
          '/sys/fs/cgroup/memory.max': '268435456\n',
        }),
      ),
      /virtualised/,
    );
  });

  it('accepts a container with a memory limit when /proc still shows the machine', async () => {
    const s = await adapter(base({ '/sys/fs/cgroup/memory.max': '268435456\n' })).read();
    expect(s.method.verification).toBe('docker-info-cross-check');
  });

  it('ignores an unlimited cgroup ("max") and reads cgroup v1 limits', async () => {
    expect(
      (await adapter(base({ '/sys/fs/cgroup/memory.max': 'max\n' })).read()).memTotalBytes,
    ).toBeGreaterThan(0);
    await refused(
      adapter(
        base({
          '/proc/meminfo': meminfo(262144, 100000),
          '/sys/fs/cgroup/memory/memory.limit_in_bytes': '268435456',
        }),
      ),
      /virtualised/,
    );
  });

  it('refuses when /proc/uptime tracks this container rather than the machine', async () => {
    await refused(
      adapter(base({ '/proc/uptime': '603.00 1.00' }), { processUptime: () => 600 }),
      /uptime/,
    );
    await refused(
      adapter(base({ '/proc/uptime': '5.00 1.00' }), { processUptime: () => 600 }),
      /uptime/,
    );
    expect(
      (
        await adapter(base({ '/proc/uptime': '999999.00 1.00' }), {
          processUptime: () => 600,
        }).read()
      ).uptimeSeconds,
    ).toBe(999999);
  });

  it('refuses Docker Desktop / WSL2, where /proc describes a VM, not the machine', async () => {
    const desktop = async () => ({
      memTotalBytes: 7340032 * 1024,
      ncpu: 4,
      operatingSystem: 'Docker Desktop',
      kernelVersion: '6.18.33.1-microsoft-standard-WSL2',
    });
    await refused(adapter(base(), { daemon: desktop }), /VM/);
    const wsl = async () => ({
      memTotalBytes: 7340032 * 1024,
      ncpu: 4,
      operatingSystem: 'Ubuntu',
      kernelVersion: '5.15.90.1-microsoft-standard-WSL2',
    });
    await refused(adapter(base(), { daemon: wsl }), /VM/);
  });

  it('accepts a VM kernel only when the operator explicitly asserts it, and labels it so', async () => {
    const desktop = async () => ({
      memTotalBytes: 7340032 * 1024,
      ncpu: 4,
      operatingSystem: 'Docker Desktop',
      kernelVersion: 'x-WSL2',
    });
    const s = await adapter(base(), { daemon: desktop, assertProcIsHost: true }).read();
    expect(s.method.verification).toBe('operator-asserted');
  });

  it('never lets the assertion override a real contradiction with the Docker daemon', async () => {
    const other = async () => ({
      memTotalBytes: 16 * GiB,
      ncpu: 8,
      operatingSystem: 'Ubuntu',
      kernelVersion: '7.0',
    });
    await refused(
      adapter(base(), { daemon: other, assertProcIsHost: true }),
      /differs from the Docker daemon/,
    );
  });

  it('refuses when /proc MemTotal disagrees with the Docker daemon', async () => {
    const other = async () => ({
      memTotalBytes: 16 * GiB,
      ncpu: 8,
      operatingSystem: 'Ubuntu',
      kernelVersion: '7.0',
    });
    await refused(adapter(base(), { daemon: other }), /differs from the Docker daemon/);
  });

  it('tolerates a 2% difference between /proc and the daemon (rounding)', async () => {
    const near = async () => ({
      memTotalBytes: Math.round(7340032 * 1024 * 1.01),
      ncpu: 8,
      operatingSystem: 'Ubuntu',
      kernelVersion: '7.0',
    });
    expect((await adapter(base(), { daemon: near }).read()).method.verification).toBe(
      'docker-info-cross-check',
    );
  });

  it('refuses when Docker cannot be asked and nothing was asserted', async () => {
    await refused(
      adapter(base(), {
        daemon: async () => {
          throw new Error('down');
        },
      }),
      /cannot cross-check/i,
    );
    await refused(adapter(base(), { daemon: undefined }), /cannot cross-check/i);
  });

  it('falls back to the operator assertion when Docker is unreachable, and is labelled as such', async () => {
    const s = await adapter(base(), {
      daemon: async () => {
        throw new Error('down');
      },
      assertProcIsHost: true,
    }).read();
    expect(s.method).toEqual({ kind: 'procfs', verification: 'operator-asserted' });
  });

  it('still catches a virtualised /proc even when the operator asserts', async () => {
    await refused(
      adapter(
        base({
          '/proc/meminfo': meminfo(262144, 100000),
          '/sys/fs/cgroup/memory.max': '268435456',
        }),
        { assertProcIsHost: true },
      ),
      /virtualised/,
    );
  });
});

describe('parseMountInfo', () => {
  it('reads the kernel format: device, mount point and filesystem type', () => {
    const m = parseMountInfo(
      mountinfo(
        mnt(1, '0:89', '/', '/', 'overlay', 'overlay'),
        mnt(2, '8:2', '/srv/projects/x/probe/root', '/probe/root', 'ext4', '/dev/sda2'),
        mnt(3, '8:17', '/', '/probe/storage', 'ext4', '/dev/sdb1'),
      ),
    )!;
    expect(m.get('/probe/root')).toEqual({
      device: '8:2',
      mountPoint: '/probe/root',
      fsType: 'ext4',
    });
    expect(m.get('/probe/storage')?.device).toBe('8:17');
    expect(m.get('/')?.fsType).toBe('overlay');
  });

  it('decodes escaped spaces, lets a later mount hide an earlier one, and skips junk lines', () => {
    const m = parseMountInfo(
      mountinfo(
        mnt(1, '8:2', '/', '/probe/my\\040disk', 'ext4'),
        'complete nonsense',
        '5 1 not-a-device / /x rw - ext4 /dev/x rw',
        '6 1 8:3 / /y rw',
        mnt(7, '8:2', '/', '/probe/a', 'ext4'),
        mnt(8, '8:9', '/', '/probe/a', 'xfs'),
      ),
    )!;
    expect(m.get('/probe/my disk')?.fsType).toBe('ext4');
    expect(m.get('/x')).toBeUndefined();
    expect(m.get('/y')).toBeUndefined();
    expect(m.get('/probe/a')).toMatchObject({ device: '8:9', fsType: 'xfs' });
  });

  it('returns null for a missing or unusable table', () => {
    expect(parseMountInfo(null)).toBeNull();
    expect(parseMountInfo('')).toBeNull();
    expect(parseMountInfo('garbage\nmore garbage\n')).toBeNull();
  });
});

describe('host adapter: disks and the secondary mount', () => {
  const disks: DiskConfig[] = [
    { label: '/', path: '/probe/root', separate: false },
    { label: '/srv/storage', path: '/probe/storage', separate: true },
  ];
  const sizes: Record<string, Sfs> = {
    '/probe/root': { bsize: 4096, blocks: 100_000_000, bfree: 90_000_000, bavail: 85_000_000 },
    '/probe/storage': { bsize: 4096, blocks: 30_000_000, bfree: 29_000_000, bavail: 28_500_000 },
  };
  const table = (...extra: string[]) => ({
    '/proc/self/mountinfo': mountinfo(
      mnt(1, '0:89', '/', '/', 'overlay', 'overlay'),
      mnt(2, '8:2', '/srv/projects/hlcc/probe/root', '/probe/root', 'ext4', '/dev/sda2'),
      ...extra,
    ),
  });
  const run = (files: Record<string, string>, ds = disks, statfs: Record<string, Sfs> = sizes) =>
    adapter(base(files), { disks: ds }, { statfs }).read();

  it('reports both filesystems when the secondary is a real mount on a different device', async () => {
    const s = await run(
      table(mnt(3, '8:17', '/homelab-control-center/probe', '/probe/storage', 'ext4', '/dev/sdb1')),
    );
    expect(s.disks).toEqual([
      {
        mount: '/',
        status: 'ok',
        fsType: 'ext4',
        totalBytes: 100_000_000 * 4096,
        usedBytes: 10_000_000 * 4096,
        availableBytes: 85_000_000 * 4096,
      },
      {
        mount: '/srv/storage',
        status: 'ok',
        fsType: 'ext4',
        totalBytes: 30_000_000 * 4096,
        usedBytes: 1_000_000 * 4096,
        availableBytes: 28_500_000 * 4096,
      },
    ]);
  });

  it('never reports root-filesystem space as the secondary disk', async () => {
    // The "secondary" path is a bind mount of a folder on the root disk: same device 8:2.
    const s = await run(
      table(mnt(3, '8:2', '/srv/storage', '/probe/storage', 'ext4', '/dev/sda2')),
    );
    expect(s.disks[0]).toMatchObject({ status: 'ok' });
    expect(s.disks[1]).toMatchObject({ mount: '/srv/storage', status: 'not_separate_mount' });
    expect(JSON.stringify(s.disks[1])).not.toMatch(/totalBytes|availableBytes|usedBytes/);
  });

  it('refuses a path that is not a mount point at all: it would describe the container itself', async () => {
    const s = await run(table()); // /probe/storage has no mount entry
    expect(s.disks[1]).toMatchObject({ status: 'unreadable' });
    expect((s.disks[1] as { message: string }).message).toMatch(/not a mount point/);
    // Even the reference disk is refused if it is only a folder inside the container.
    const noRoot = await run({
      '/proc/self/mountinfo': mountinfo(mnt(1, '0:89', '/', '/', 'overlay', 'overlay')),
    });
    expect(noRoot.disks[0]).toMatchObject({ status: 'unreadable' });
  });

  it('refuses memory-backed or container filesystems as a disk', async () => {
    const tmp = await run(table(mnt(3, '0:50', '/', '/probe/storage', 'tmpfs', 'tmpfs')));
    expect(tmp.disks[1]).toMatchObject({ status: 'unreadable' });
    expect((tmp.disks[1] as { message: string }).message).toMatch(/tmpfs/);
    const overlay = await run({
      '/proc/self/mountinfo': mountinfo(
        mnt(1, '0:89', '/', '/probe/root', 'overlay', 'overlay'),
        mnt(2, '8:17', '/', '/probe/storage', 'ext4'),
      ),
    });
    expect(overlay.disks[0]).toMatchObject({ status: 'unreadable' });
    // With no verified reference, the secondary cannot be vouched for either.
    expect(overlay.disks[1]).toMatchObject({ status: 'unreadable' });
  });

  it('cannot verify a separate disk without a reference filesystem', async () => {
    const s = await run(
      { '/proc/self/mountinfo': mountinfo(mnt(1, '8:17', '/', '/probe/storage', 'ext4')) },
      [disks[1]!],
    );
    expect(s.disks[0]).toMatchObject({ status: 'unreadable' });
  });

  it('reports a genuine zero of available space as zero, not as missing', async () => {
    const full = {
      ...sizes,
      '/probe/storage': { bsize: 4096, blocks: 1000, bfree: 20, bavail: 0 },
    };
    const s = await run(table(mnt(3, '8:17', '/', '/probe/storage', 'ext4')), disks, full);
    expect(s.disks[1]).toMatchObject({ status: 'ok', availableBytes: 0, usedBytes: 980 * 4096 });
  });

  it('refuses implausible or empty filesystem statistics', async () => {
    const mt = table(mnt(3, '8:17', '/', '/probe/storage', 'ext4'));
    const zero = await run(mt, disks, {
      ...sizes,
      '/probe/storage': { bsize: 4096, blocks: 0, bfree: 0, bavail: 0 },
    });
    expect(zero.disks[1]).toMatchObject({ status: 'unreadable' });
    const bad = await run(mt, disks, {
      ...sizes,
      '/probe/storage': { bsize: 4096, blocks: 100, bfree: 500, bavail: 10 },
    });
    expect(bad.disks[1]).toMatchObject({ status: 'unreadable' });
    const noStats = await run(mt, disks, { '/probe/root': sizes['/probe/root']! });
    expect(noStats.disks[1]).toMatchObject({ status: 'unreadable' });
  });

  it('marks every disk unverifiable when the mount table cannot be read', async () => {
    const cases: Record<string, string>[] = [
      {},
      { '/proc/self/mountinfo': '' },
      { '/proc/self/mountinfo': 'garbage' },
    ];
    for (const files of cases) {
      const s = await run(files);
      expect(s.disks.map((d) => d.status)).toEqual(['unreadable', 'unreadable']);
    }
  });

  it('reports no disks when none are configured', async () => {
    expect((await adapter(base()).read()).disks).toEqual([]);
  });

  it('only ever looks at administrator-configured paths', async () => {
    const asked: string[] = [];
    const inner = fakeFs({
      files: { ...base(), ...table(mnt(3, '8:17', '/', '/probe/storage', 'ext4')) },
      statfs: sizes,
    });
    const fs: FsOps = {
      readText: inner.readText,
      statfs: async (p) => {
        asked.push(p);
        return inner.statfs(p);
      },
    };
    await createHostAdapter({
      clock: () => 0,
      disks,
      daemon: daemonOk,
      processUptime: () => 10,
      fs,
    }).read();
    expect(asked.sort()).toEqual(['/probe/root', '/probe/storage']);
  });
});

describe.runIf(process.platform === 'linux')('host adapter: real /proc on Linux', () => {
  it('parses the real procfs and mount table of the machine running the tests', async () => {
    const a = createHostAdapter({
      clock: Date.now,
      disks: [],
      assertProcIsHost: true,
      processUptime: () => 0,
    });
    const s = await a.read();
    expect(s.memTotalBytes).toBeGreaterThan(0);
    expect(s.uptimeSeconds).toBeGreaterThan(0);
    expect(s.method.verification).toBe('operator-asserted');
    const real = parseMountInfo(
      await (await import('node:fs/promises')).readFile('/proc/self/mountinfo', 'utf8'),
    );
    expect(real?.get('/')).toBeDefined();
  });
});
