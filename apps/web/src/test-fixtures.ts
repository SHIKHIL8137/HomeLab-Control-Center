import type { ContainerView, Overview } from '@hlcc/shared';

export const host = {
  collectedAt: '2026-10-14T12:00:00.000Z',
  cpuPercent: 21.5,
  memTotalBytes: 7 * 1024 ** 3,
  memUsedBytes: 1.1 * 1024 ** 3,
  memAvailableBytes: 5.9 * 1024 ** 3,
  swapTotalBytes: 4 * 1024 ** 3,
  swapUsedBytes: 0,
  memPressureAvg60: 1.2,
  load1: 0.4,
  uptimeSeconds: 3600,
  bootTime: '2026-10-14T11:00:00.000Z',
  disks: [{ mount: '/', totalBytes: 458e9, usedBytes: 32e9 }],
};

export function overview(over: Partial<Overview> = {}): Overview {
  return {
    mode: 'mock',
    generatedAt: '2026-10-14T12:00:05.000Z',
    pollIntervalMs: 15000,
    host: { freshness: 'current', collectedAt: host.collectedAt, source: 'mock', data: host },
    docker: {
      freshness: 'current',
      collectedAt: host.collectedAt,
      source: 'mock',
      data: { daemonUp: true, total: 5, running: 3, stopped: 2, unhealthy: 0, restarting: 0 },
    },
    projects: [
      {
        id: 'demo',
        name: 'Demo',
        desiredState: 'running',
        health: { status: 'healthy', reason: 'All containers running' },
      },
    ],
    collectorError: null,
    deployments: { available: false, reason: 'Deployment history arrives in Phase 5' },
    alerts: { available: false, reason: 'Alert rules and incidents arrive in Phase 4' },
    ...over,
  };
}

export const container = (over: Partial<ContainerView> = {}): ContainerView => ({
  id: 'c1',
  name: 'auth-service',
  image: 'x:1',
  state: 'exited',
  health: 'none',
  restartCount: 58,
  exitCode: 1,
  createdAt: '2026-10-12T00:00:00Z',
  startedAt: null,
  cpuPercent: null,
  memUsageBytes: null,
  memLimitBytes: 256 * 1024 ** 2,
  ports: [],
  projectId: 'devconnect',
  stopIntent: 'unknown',
  ...over,
});
