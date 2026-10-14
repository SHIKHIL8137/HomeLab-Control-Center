import { readFile, statfs } from 'node:fs/promises';
import { posix } from 'node:path';
import { z } from 'zod';
import type { DaemonInfo, DiskUsage, HostMethod, HostSample } from '@hlcc/shared';
import type { Clock } from '../db.ts';
import { sleep } from '../util.ts';
import { ProviderUnavailableError } from './types.ts';

// procfs and cgroup paths are always POSIX, whatever OS runs the tests.
const join = posix.join;

export const diskConfigSchema = z.array(
  z.object({
    /** Name shown in the UI, normally the path on the host, e.g. "/srv/storage". */
    label: z.string().min(1).max(80),
    /** Where that filesystem is visible inside this container. Fixed by the administrator. */
    path: z.string().regex(/^\/[A-Za-z0-9_./-]*$/),
    /** True for a second disk that must be its own mount, never a folder on the root filesystem. */
    separate: z.boolean().default(false),
  }),
);
export type DiskConfig = z.infer<typeof diskConfigSchema>[number];

export interface FsOps {
  readText(path: string): Promise<string | null>;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
}

const realFs: FsOps = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async statfs(path) {
    const s = await statfs(path);
    return {
      bsize: Number(s.bsize),
      blocks: Number(s.blocks),
      bfree: Number(s.bfree),
      bavail: Number(s.bavail),
    };
  },
};

export interface HostAdapterOptions {
  clock: Clock;
  disks: DiskConfig[];
  /** Daemon facts for cross-checking /proc; rejects when Docker is unreachable. */
  daemon?: () => Promise<DaemonInfo>;
  /** The operator states that /proc belongs to the monitored machine. Weaker than the cross-check. */
  assertProcIsHost?: boolean;
  procRoot?: string;
  cgroupRoot?: string;
  fs?: FsOps;
  processUptime?: () => number;
}

function fail(message: string): never {
  throw new ProviderUnavailableError(message);
}

function kb(meminfo: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(meminfo);
  if (!m) fail(`Unexpected /proc/meminfo format (no ${key})`);
  return Number(m[1]) * 1024;
}

function parseCpu(stat: string): { total: number; idle: number } {
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  const f = line?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!f || f.length < 8 || f.some((n) => !Number.isFinite(n) || n < 0)) {
    fail('Unexpected /proc/stat format');
  }
  return { total: f.reduce((a, b) => a + b, 0), idle: (f[3] as number) + (f[4] as number) };
}

export interface MountEntry {
  /** Device as "major:minor"; two mounts of the same filesystem share it. */
  device: string;
  mountPoint: string;
  fsType: string;
}

/** mountinfo escapes spaces and a few other bytes as \040-style octal. */
const unescapeMount = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));

/** Parses /proc/self/mountinfo. Malformed lines are skipped; an unusable table yields null. */
export function parseMountInfo(text: string | null): Map<string, MountEntry> | null {
  if (text === null) return null;
  const out = new Map<string, MountEntry>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    const dash = parts.indexOf('-');
    const device = parts[2];
    const mountPoint = parts[4];
    const fsType = dash > 0 ? parts[dash + 1] : undefined;
    if (!device || !/^\d+:\d+$/.test(device) || !mountPoint || !fsType) continue;
    // A later mount at the same path hides the earlier one, so the last entry wins.
    out.set(unescapeMount(mountPoint), { device, mountPoint: unescapeMount(mountPoint), fsType });
  }
  return out.size > 0 ? out : null;
}

/** Filesystems that cannot be a persistent disk: the answer would describe memory or the container itself. */
const NOT_A_DISK = new Set([
  'tmpfs',
  'ramfs',
  'overlay',
  'devtmpfs',
  'squashfs',
  'proc',
  'sysfs',
  'cgroup2',
]);

export interface HostAdapter {
  read(): Promise<HostSample>;
}

export function createHostAdapter(opts: HostAdapterOptions): HostAdapter {
  const proc = opts.procRoot ?? '/proc';
  const cgroup = opts.cgroupRoot ?? '/sys/fs/cgroup';
  const fs = opts.fs ?? realFs;
  const processUptime = opts.processUptime ?? (() => process.uptime());
  let prevCpu: { total: number; idle: number } | null = null;

  const readProc = async (name: string): Promise<string> => {
    const text = await fs.readText(join(proc, name));
    if (text === null) fail(`Cannot read ${join(proc, name)}`);
    return text;
  };

  /**
   * /proc inside a container shows the kernel the container runs on. That is the host only when
   * the Docker daemon runs on the monitored machine itself. We refuse to call it "host" unless:
   *   1. it is not virtualised per container (MemTotal != cgroup limit, uptime != container uptime), and
   *   2. it matches the Docker daemon's own view of the machine and the daemon is not in a VM,
   *      or the operator has explicitly asserted it.
   */
  const verify = async (memTotal: number, uptimeSeconds: number): Promise<HostMethod> => {
    const limitText =
      (await fs.readText(join(cgroup, 'memory.max'))) ??
      (await fs.readText(join(cgroup, 'memory', 'memory.limit_in_bytes')));
    const limit = limitText && /^\d+$/.test(limitText.trim()) ? Number(limitText.trim()) : null;
    if (limit !== null && memTotal <= limit * 1.001) {
      fail(
        'Host metrics refused: /proc/meminfo equals the container memory limit, so /proc is virtualised',
      );
    }
    const own = processUptime();
    if (uptimeSeconds < own - 1 || (own > 60 && uptimeSeconds - own < 5)) {
      fail('Host metrics refused: /proc/uptime tracks this container, not the machine');
    }

    let daemon: DaemonInfo | null = null;
    if (opts.daemon) {
      try {
        daemon = await opts.daemon();
      } catch {
        daemon = null;
      }
    }
    if (daemon) {
      if (
        /docker desktop/i.test(daemon.operatingSystem ?? '') ||
        /microsoft|wsl/i.test(daemon.kernelVersion ?? '')
      ) {
        if (!opts.assertProcIsHost) {
          fail(
            'Host metrics refused: the Docker daemon runs in a VM (Docker Desktop/WSL2), so /proc describes the VM, not the machine',
          );
        }
        return { kind: 'procfs', verification: 'operator-asserted' };
      }
      if (daemon.memTotalBytes !== null) {
        if (Math.abs(memTotal - daemon.memTotalBytes) / daemon.memTotalBytes > 0.02) {
          fail(
            "Host metrics refused: /proc MemTotal differs from the Docker daemon, so /proc is not from the daemon's kernel",
          );
        }
        return { kind: 'procfs', verification: 'docker-info-cross-check' };
      }
    }
    if (opts.assertProcIsHost) return { kind: 'procfs', verification: 'operator-asserted' };
    return fail(
      'Host metrics refused: cannot cross-check /proc against the Docker daemon (Docker unavailable) and HLCC_HOST_PROC_ASSERT is not set',
    );
  };

  /**
   * A disk is only measured when its configured path is a real mount point (a bind mount from the
   * host). A plain folder inside the container would silently report the container's own storage.
   * A "separate" disk must additionally be a different filesystem from the reference disk and a
   * real block-device filesystem, never tmpfs or overlay.
   */
  const readDisks = async (): Promise<DiskUsage[]> => {
    if (opts.disks.length === 0) return [];
    const mounts = parseMountInfo(await fs.readText(join(proc, 'self', 'mountinfo')));
    const unreadable = (mount: string, message: string): DiskUsage => ({
      mount,
      status: 'unreadable',
      message,
    });
    if (!mounts) {
      return opts.disks.map((d) =>
        unreadable(d.label, 'The mount table could not be read, so no disk can be verified'),
      );
    }
    const primary = opts.disks.find((d) => !d.separate);
    // The reference must itself be a genuine disk, or comparing against it proves nothing.
    const candidate = primary ? mounts.get(primary.path) : undefined;
    const primaryMount = candidate && !NOT_A_DISK.has(candidate.fsType) ? candidate : undefined;

    const out: DiskUsage[] = [];
    for (const d of opts.disks) {
      const m = mounts.get(d.path);
      if (!m) {
        out.push(
          unreadable(
            d.label,
            `${d.path} is not a mount point (missing bind mount?). Reading it would describe the container's own storage`,
          ),
        );
        continue;
      }
      if (NOT_A_DISK.has(m.fsType)) {
        out.push(
          unreadable(
            d.label,
            `${d.path} is a ${m.fsType} filesystem, not a persistent disk, so it is not reported`,
          ),
        );
        continue;
      }
      if (d.separate) {
        if (!primary || !primaryMount) {
          out.push(
            unreadable(
              d.label,
              'No verified reference filesystem is configured to compare this mount against',
            ),
          );
          continue;
        }
        if (m.device === primaryMount.device) {
          out.push({
            mount: d.label,
            status: 'not_separate_mount',
            message: `${d.label} is on the same filesystem as ${primary.label}; the secondary disk does not appear to be mounted`,
          });
          continue;
        }
      }
      try {
        const s = await fs.statfs(d.path);
        if (!(s.blocks > 0) || !(s.bsize > 0) || s.bfree > s.blocks || s.bavail > s.blocks) {
          throw new Error('implausible');
        }
        out.push({
          mount: d.label,
          status: 'ok',
          fsType: m.fsType,
          totalBytes: s.blocks * s.bsize,
          usedBytes: (s.blocks - s.bfree) * s.bsize,
          // "Available" excludes reserved blocks, so it can be genuinely zero while bfree is not.
          availableBytes: s.bavail * s.bsize,
        });
      } catch {
        out.push(unreadable(d.label, `Cannot read filesystem statistics for ${d.path}`));
      }
    }
    return out;
  };

  return {
    async read() {
      const meminfo = await readProc('meminfo');
      const memTotal = kb(meminfo, 'MemTotal');
      const memAvailable = kb(meminfo, 'MemAvailable');
      const swapTotal = kb(meminfo, 'SwapTotal');
      const swapFree = kb(meminfo, 'SwapFree');
      // Values that cannot be true mean the file is not what we think it is.
      if (memTotal <= 0 || memAvailable > memTotal || swapFree > swapTotal) {
        fail('Unexpected /proc/meminfo values (inconsistent totals)');
      }

      const uptime = Number.parseFloat((await readProc('uptime')).split(/\s+/)[0] ?? '');
      if (!Number.isFinite(uptime) || uptime < 0) fail('Unexpected /proc/uptime format');

      const method = await verify(memTotal, uptime);

      // CPU% is a rate, so it needs two readings; the very first call takes a short second one.
      let cpu = parseCpu(await readProc('stat'));
      let base = prevCpu;
      if (!base) {
        base = { total: cpu.total, idle: cpu.idle };
        await sleep(250);
        cpu = parseCpu(await readProc('stat'));
      }
      prevCpu = { total: cpu.total, idle: cpu.idle };
      const dTotal = cpu.total - base.total;
      const dIdle = cpu.idle - base.idle;
      // No elapsed ticks, or counters that went backwards (reset, VM migration): unknown, not 0%.
      const cpuPercent =
        dTotal > 0 && dIdle >= 0 && dIdle <= dTotal
          ? Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10
          : null;

      const loadText = await fs.readText(join(proc, 'loadavg'));
      const load1 = loadText ? Number.parseFloat(loadText.split(/\s+/)[0] ?? '') : NaN;
      const psi = await fs.readText(join(proc, 'pressure', 'memory'));
      const avg60 = psi ? /^some .*avg60=([\d.]+)/m.exec(psi)?.[1] : undefined;

      const now = opts.clock();
      return {
        collectedAt: new Date(now).toISOString(),
        method,
        cpuPercent,
        memTotalBytes: memTotal,
        memUsedBytes: memTotal - memAvailable,
        memAvailableBytes: memAvailable,
        swapTotalBytes: swapTotal,
        swapUsedBytes: swapTotal - swapFree,
        memPressureAvg60: avg60 !== undefined ? Number(avg60) : null,
        load1: Number.isFinite(load1) ? load1 : null,
        uptimeSeconds: Math.floor(uptime),
        bootTime: new Date(now - uptime * 1000).toISOString(),
        disks: await readDisks(),
      };
    },
  };
}
