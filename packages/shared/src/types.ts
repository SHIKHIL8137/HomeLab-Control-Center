export type DataSource = 'mock' | 'live';

export interface DiskUsage {
  mount: string;
  totalBytes: number;
  usedBytes: number;
}

export interface HostSample {
  collectedAt: string; // ISO time of the measurement, not of the request
  cpuPercent: number;
  memTotalBytes: number;
  memUsedBytes: number;
  memAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /** PSI "some avg60" percentage; null when the host does not expose it. */
  memPressureAvg60: number | null;
  load1: number | null;
  uptimeSeconds: number;
  bootTime: string;
  disks: DiskUsage[];
}

export type ContainerState = 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead';
export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  health: ContainerHealth;
  restartCount: number;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  /** Measured usage. Never derive this from the configured limit. */
  cpuPercent: number | null;
  memUsageBytes: number | null;
  /** Configured cap; null means unlimited. A cap is not consumption. */
  memLimitBytes: number | null;
  ports: string[];
}

export interface DockerSummary {
  daemonUp: boolean;
  total: number;
  running: number;
  stopped: number;
  unhealthy: number;
  restarting: number;
}
