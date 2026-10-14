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

export type HttpCheckState = 'not_configured' | 'pending' | 'ok' | 'failed' | 'blocked';

export interface HttpCheckStatus {
  state: HttpCheckState;
  statusCode: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  error: string | null;
  /** Network class of the address that was actually contacted. */
  targetClass: 'public' | 'private' | null;
  source: DataSource | null;
  freshness: Freshness;
}

export interface ProjectSummary {
  id: string;
  name: string;
  desiredState: Project['desiredState'];
  health: ProjectHealth;
  httpCheck: HttpCheckState;
}

export type ConnectivityState =
  'ok' | 'degraded' | 'failed' | 'not_configured' | 'needs_host_agent' | 'unknown';

export interface ConnectivityItem {
  id: 'link' | 'gateway' | 'tailscale' | 'public' | 'tunnel';
  label: string;
  state: ConnectivityState;
  detail: string;
}

export interface NetdataExtras {
  netInKbps: number | null;
  netOutKbps: number | null;
  diskReadKiBps: number | null;
  diskWriteKiBps: number | null;
}

export type NetdataReading =
  { configured: false } | ({ configured: true; error: string | null } & Reading<NetdataExtras>);

export interface SourceError {
  at: string;
  message: string;
}

export interface Overview {
  mode: DataSource;
  generatedAt: string;
  pollIntervalMs: number;
  host: Reading<HostSample>;
  docker: Reading<DockerSummary>;
  netdata: NetdataReading;
  projects: ProjectSummary[];
  connectivity: ConnectivityItem[];
  /** Each integration fails on its own; one failing never blanks the others. */
  collectorErrors: {
    host: SourceError | null;
    docker: SourceError | null;
    storage: SourceError | null;
  };
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
  /** Partial failures, e.g. one container that could not be inspected. */
  warnings: string[];
  items: ContainerView[];
}

export interface ProjectView extends Project {
  health: ProjectHealth;
  containersObserved: ContainerView[];
  freshness: Freshness;
  httpCheck: HttpCheckStatus;
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

export interface EventItem {
  id: number;
  ts: number;
  container: string;
  action: string;
  exitCode: number | null;
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

/**
 * How the current request reached the server, to help choose HLCC_TRUST_PROXY. `candidates` lists
 * the client address the server would use for each hop count; the right count is the one whose
 * address is the administrator's real public address.
 */
export interface NetworkIdentity {
  /** The address the server is using for this client now (and for rate limiting). */
  clientAddress: string | null;
  /** The address that actually connected to the server (the nearest proxy, or the client itself). */
  peerAddress: string | null;
  /** The X-Forwarded-For chain as received, nearest-to-client first. Client-controlled where untrusted. */
  forwardedFor: string[];
  configuredHops: number;
  candidates: { hops: number; address: string }[];
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
