import type { ContainerInfo, DockerSnapshot, HostSample, NetdataExtras } from '@hlcc/shared';
import type { Clock } from '../db.ts';
import type { Provider } from './types.ts';

const GiB = 1024 ** 3;
const GB = 1e9;

interface Def {
  name: string;
  image: string;
  state: ContainerInfo['state'];
  health?: ContainerInfo['health'];
  exitCode?: number;
  restarts?: number;
  memMiB?: number;
  limitMiB?: number;
  ports?: string[];
}

const exited = (
  name: string,
  image: string,
  exitCode: number,
  limitMiB: number,
  restarts = 0,
): Def => ({
  name,
  image,
  state: 'exited',
  exitCode,
  restarts,
  limitMiB,
});

// Shaped like the baseline discovered in the infrastructure audit; every value here is demo data.
const DEFS: Def[] = [
  {
    name: 'devworkspace-nginx',
    image: 'nginx:alpine',
    state: 'running',
    memMiB: 9,
    ports: ['80/tcp'],
  },
  { name: 'cloudflared', image: 'cloudflare/cloudflared:latest', state: 'running', memMiB: 28 },
  {
    name: 'nextcloud',
    image: 'nextcloud:apache',
    state: 'running',
    memMiB: 310,
    ports: ['127.0.0.1:8080->80/tcp'],
  },
  {
    name: 'nextcloud-db',
    image: 'postgres:16-alpine',
    state: 'running',
    health: 'healthy',
    memMiB: 64,
    ports: ['5432/tcp'],
  },
  {
    name: 'netdata',
    image: 'netdata/netdata:stable',
    state: 'running',
    health: 'healthy',
    memMiB: 190,
  },
  exited('auth-service', 'devconnect/auth-service:e269d58', 1, 256, 58),
  exited('payment-service', 'devconnect/payment-service:e269d58', 1, 256, 54),
  ...[
    'gateway',
    'user',
    'project',
    'bidding',
    'chat',
    'complaint',
    'verification',
    'socket',
    'upload',
  ].map((s) => exited(`${s}-service`, `devconnect/${s}-service:e269d58`, 137, 256)),
  exited('devconnect-kafka', 'apache/kafka:3.9.0', 137, 1024),
  exited('devconnect-mongo', 'mongo:7', 0, 768),
  exited('devconnect-redis', 'redis:7-alpine', 0, 128),
  exited('devconnect-frontend', 'devconnect/frontend:e269d58', 0, 64),
  exited('devconnect-edge', 'nginx:alpine', 0, 64),
];

export function createMockProvider(clock: Clock): Provider {
  const started = clock();
  return {
    source: 'mock',
    async host(): Promise<HostSample> {
      const t = clock();
      const phase = t / 60_000;
      const bootMs = started - 70 * 3_600_000;
      const memUsed = Math.round(1.1 * GiB + 0.25 * GiB * Math.sin(phase / 2.3));
      const total = 7 * GiB;
      const cpu = Math.min(98, Math.max(2, 18 + 12 * Math.sin(phase) + 6 * Math.sin(phase * 3.1)));
      return {
        collectedAt: new Date(t).toISOString(),
        method: { kind: 'mock', verification: 'mock' },
        cpuPercent: Math.round(cpu * 10) / 10,
        memTotalBytes: total,
        memUsedBytes: memUsed,
        memAvailableBytes: total - memUsed,
        swapTotalBytes: 4 * GiB,
        swapUsedBytes: 0,
        memPressureAvg60: Math.max(0, Math.round((1.5 + 1.2 * Math.sin(phase / 4)) * 10) / 10),
        load1: Math.round((cpu / 100) * 8 * 100) / 100,
        uptimeSeconds: Math.floor((t - bootMs) / 1000),
        bootTime: new Date(bootMs).toISOString(),
        disks: [
          {
            mount: '/',
            status: 'ok',
            fsType: 'ext4',
            totalBytes: 458 * GB,
            usedBytes: 32 * GB,
            availableBytes: 400 * GB,
          },
          {
            mount: '/srv/storage',
            status: 'ok',
            fsType: 'ext4',
            totalBytes: 146 * GB,
            usedBytes: 2 * GB,
            availableBytes: 137 * GB,
          },
        ],
      };
    },
    async docker(): Promise<DockerSnapshot> {
      const t = clock();
      const containers = DEFS.map((d): ContainerInfo => {
        const running = d.state === 'running';
        return {
          id: `mock-${d.name}`,
          name: d.name,
          image: d.image,
          state: d.state,
          health: d.health ?? 'none',
          restartCount: d.restarts ?? 0,
          exitCode: running ? null : (d.exitCode ?? 0),
          createdAt: '2026-10-12T16:00:00.000Z',
          startedAt: running ? new Date(started - 3_600_000).toISOString() : null,
          cpuPercent: running
            ? Math.round((1 + 2 * Math.abs(Math.sin(t / 30_000 + d.name.length))) * 10) / 10
            : null,
          memUsageBytes: running ? (d.memMiB ?? 0) * 1024 ** 2 : null,
          memLimitBytes: d.limitMiB ? d.limitMiB * 1024 ** 2 : null,
          ports: d.ports ?? [],
        };
      });
      return {
        containers,
        // One fixed event per instance, so the events list has something labelled demo to show.
        events: [{ ts: started, container: 'auth-service', action: 'die', exitCode: 1 }],
        daemon: {
          memTotalBytes: 7 * GiB,
          ncpu: 8,
          operatingSystem: 'Mock Linux',
          kernelVersion: 'mock',
        },
        warnings: [],
      };
    },
    async netdata(): Promise<NetdataExtras> {
      const phase = clock() / 20_000;
      return {
        netInKbps: Math.round((120 + 60 * Math.sin(phase)) * 10) / 10,
        netOutKbps: Math.round((40 + 20 * Math.sin(phase * 1.7)) * 10) / 10,
        diskReadKiBps: Math.round((30 + 20 * Math.sin(phase * 0.6)) * 10) / 10,
        diskWriteKiBps: Math.round((55 + 30 * Math.sin(phase * 0.9)) * 10) / 10,
      };
    },
  };
}
