import type { Freshness } from './freshness.ts';
import type { ContainerInfo, DataSource, DockerSummary, HostSample } from './types.ts';
import type { Project, ProjectHealth } from './project.ts';

/** A measurement with the metadata needed to judge it: age, origin and whether it is trustworthy. */
export interface Reading<T> {
  freshness: Freshness;
  collectedAt: string | null;
  source: DataSource;
  data: T | null;
}

export interface NotAvailable {
  available: false;
  reason: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  desiredState: Project['desiredState'];
  health: ProjectHealth;
}

export interface Overview {
  mode: DataSource;
  generatedAt: string;
  pollIntervalMs: number;
  host: Reading<HostSample>;
  docker: Reading<DockerSummary>;
  projects: ProjectSummary[];
  collectorError: { at: string; message: string } | null;
  deployments: NotAvailable;
  alerts: NotAvailable;
}

export type StopIntent = 'intentional' | 'unexpected' | 'unknown';

export interface ContainerView extends ContainerInfo {
  projectId: string | null;
  /** Set only for containers that are not running. */
  stopIntent: StopIntent | null;
}

export interface ContainersResponse {
  freshness: Freshness;
  collectedAt: string | null;
  source: DataSource;
  items: ContainerView[];
}

export interface ProjectView extends Project {
  health: ProjectHealth;
  containersObserved: ContainerView[];
  freshness: Freshness;
  /** Health URLs are stored but not probed until the Phase 3 health-check adapter exists. */
  healthCheck: NotAvailable;
}

export interface HistoryPoint {
  ts: number;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
}

export interface MetricsHistory {
  source: DataSource;
  freshness: Freshness;
  collectedAt: string | null;
  units: { cpu: '%'; memory: 'bytes' };
  from: number;
  to: number;
  points: HistoryPoint[];
}

export interface AuditEvent {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  outcome: string;
  ip: string | null;
  detail: unknown;
}

export interface AuthStatus {
  mode: DataSource;
  setupRequired: boolean;
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
}

export interface ApiError {
  error: { code: string; message: string; issues?: { path: string; message: string }[] };
}
