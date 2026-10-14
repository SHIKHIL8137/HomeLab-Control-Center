export type DataSource = 'mock' | 'live';

/**
 * A disk is either measured, or reported as a problem. A path that is not a separate mount
 * must never be reported as if it were the secondary disk.
 */
export type DiskUsage =
  | {
      mount: string;
      status: 'ok';
      fsType: string;
      totalBytes: number;
      usedBytes: number;
      /** Space usable by ordinary processes; can be genuinely zero while some blocks are free. */
      availableBytes: number;
    }
  | { mount: string; status: 'not_separate_mount' | 'unreadable'; message: string };

/** How the host numbers were obtained, and how that method was checked. */
export interface HostMethod {
  kind: 'procfs' | 'mock';
  verification: 'docker-info-cross-check' | 'operator-asserted' | 'mock';
}

export interface HostSample {
  collectedAt: string; // ISO time of the measurement, not of the request
  method: HostMethod;
  /** null when it cannot be computed (no elapsed time, or counters went backwards). */
  cpuPercent: number | null;
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

export type ContainerState =
  'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead' | 'removing';
/** 'none' means no healthcheck is defined; 'unknown' means it could not be read. */
export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none' | 'unknown';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  health: ContainerHealth;
  /** null when the container could not be inspected. */
  restartCount: number | null;
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

export interface ContainerEvent {
  ts: number;
  container: string;
  action: string;
  exitCode: number | null;
}

export interface DaemonInfo {
  memTotalBytes: number | null;
  ncpu: number | null;
  operatingSystem: string | null;
  kernelVersion: string | null;
}

export interface DockerSnapshot {
  containers: ContainerInfo[];
  events: ContainerEvent[];
  daemon: DaemonInfo;
  /** Partial failures (a container that could not be inspected, events unavailable, ...). */
  warnings: string[];
}

export interface DockerSummary {
  daemonUp: boolean;
  total: number;
  running: number;
  stopped: number;
  unhealthy: number;
  restarting: number;
}
