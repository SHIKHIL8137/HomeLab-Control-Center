import {
  deriveProjectHealth,
  freshness,
  summarizeContainers,
  type ConnectivityItem,
  type ContainerView,
  type ContainersResponse,
  type HttpCheckStatus,
  type NetdataReading,
  type Overview,
  type Project,
  type ProjectHealth,
  type ProjectView,
  type Reading,
  type SourceError,
  type StopIntent,
} from '@hlcc/shared';
import type { Config } from '../config.ts';
import type { Clock, Db } from '../db.ts';
import type { Provider } from '../providers/types.ts';
import { checkStatus } from '../repositories/health.ts';
import { latestSample } from '../repositories/metrics.ts';
import { listProjects } from '../repositories/projects.ts';
import type { Collector } from './collector.ts';

export interface ViewDeps {
  cfg: Config;
  db: Db;
  clock: Clock;
  provider: Provider;
  collector: Collector;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function containersResponse(d: ViewDeps, projects = listProjects(d.db)): ContainersResponse {
  const snap = d.collector.containers;
  const fresh = freshness(snap?.at ?? null, d.clock(), d.cfg.pollIntervalMs);
  const owner = new Map<string, Project>();
  for (const p of projects) for (const n of p.containers) owner.set(n, p);

  const items: ContainerView[] = (snap?.items ?? []).map((c) => {
    const project = owner.get(c.name);
    let stopIntent: StopIntent | null = null;
    if (c.state !== 'running') {
      stopIntent =
        project?.desiredState === 'stopped'
          ? 'intentional'
          : project?.desiredState === 'running'
            ? 'unexpected'
            : 'unknown';
    }
    return { ...c, projectId: project?.id ?? null, stopIntent };
  });
  return {
    freshness: fresh,
    collectedAt: iso(snap?.at ?? null),
    source: d.provider.source,
    warnings: snap?.warnings ?? [],
    items,
  };
}

const httpFor = (d: ViewDeps, p: Project): HttpCheckStatus =>
  checkStatus(d.db, p, d.provider.source, d.clock(), d.cfg.healthIntervalMs);

function healthFor(p: Project, c: ContainersResponse, http: HttpCheckStatus): ProjectHealth {
  // Stale or missing data must never read as healthy.
  if (c.freshness === 'stale') return { status: 'unknown', reason: 'Container data is stale' };
  // An old HTTP result is not evidence either way, so only a current one is passed on.
  const httpInput =
    http.freshness === 'current'
      ? { state: http.state, consecutiveFailures: http.consecutiveFailures }
      : undefined;
  return deriveProjectHealth(p, c.freshness === 'current' ? c.items : null, httpInput);
}

export function projectView(d: ViewDeps, p: Project, c: ContainersResponse): ProjectView {
  const http = httpFor(d, p);
  return {
    ...p,
    health: healthFor(p, c, http),
    containersObserved: c.items.filter((i) => p.containers.includes(i.name)),
    freshness: c.freshness,
    httpCheck: http,
  };
}

function netdataReading(d: ViewDeps): NetdataReading {
  if (!d.provider.netdata) return { configured: false };
  const n = d.collector.netdata;
  return {
    configured: true,
    error: d.collector.errors.netdata?.message ?? null,
    freshness: freshness(n?.at ?? null, d.clock(), d.cfg.pollIntervalMs),
    collectedAt: iso(n?.at ?? null),
    source: d.provider.source,
    data: n?.data ?? null,
  };
}

const NEEDS_AGENT =
  'Needs the host agent (design only, not installed). A container cannot see the machine’s Wi-Fi or LAN gateway truthfully.';

/** Only evidence that was actually measured is reported; everything else says why it is not. */
export function buildConnectivity(
  c: ContainersResponse,
  checks: HttpCheckStatus[],
): ConnectivityItem[] {
  const configured = checks.filter((s) => s.state !== 'not_configured');
  const publicChecks = configured.filter(
    (s) => s.targetClass === 'public' && s.freshness === 'current',
  );
  const okCount = publicChecks.filter((s) => s.state === 'ok').length;

  let pub: ConnectivityItem;
  if (configured.length === 0) {
    pub = {
      id: 'public',
      label: 'Public reachability',
      state: 'not_configured',
      detail: 'No health URL is configured yet',
    };
  } else if (publicChecks.length === 0) {
    pub = {
      id: 'public',
      label: 'Public reachability',
      state: 'unknown',
      detail: 'Configured checks are private, pending or stale',
    };
  } else {
    const state = okCount === publicChecks.length ? 'ok' : okCount === 0 ? 'failed' : 'degraded';
    pub = {
      id: 'public',
      label: 'Public reachability',
      state,
      detail: `${okCount}/${publicChecks.length} public URL(s) answered`,
    };
  }

  const tunnelContainer = c.items.find(
    (i) => i.name === 'cloudflared' || i.image.includes('cloudflare/cloudflared'),
  );
  let tunnel: ConnectivityItem;
  if (c.freshness !== 'current') {
    tunnel = {
      id: 'tunnel',
      label: 'Cloudflare Tunnel',
      state: 'unknown',
      detail: 'Container data is not current',
    };
  } else if (!tunnelContainer) {
    tunnel = {
      id: 'tunnel',
      label: 'Cloudflare Tunnel',
      state: 'unknown',
      detail: 'No cloudflared container found',
    };
  } else if (tunnelContainer.state !== 'running') {
    tunnel = {
      id: 'tunnel',
      label: 'Cloudflare Tunnel',
      state: 'failed',
      detail: `cloudflared is ${tunnelContainer.state}`,
    };
  } else if (pub.state === 'ok' || pub.state === 'degraded' || pub.state === 'failed') {
    tunnel = {
      id: 'tunnel',
      label: 'Cloudflare Tunnel',
      state: pub.state,
      detail: `cloudflared is running; end-to-end: ${pub.detail}`,
    };
  } else {
    tunnel = {
      id: 'tunnel',
      label: 'Cloudflare Tunnel',
      state: 'unknown',
      detail:
        'cloudflared is running, but a running container does not prove the tunnel works; no public health URL to test it',
    };
  }

  return [
    { id: 'link', label: 'Network link / Wi-Fi', state: 'needs_host_agent', detail: NEEDS_AGENT },
    { id: 'gateway', label: 'LAN gateway', state: 'needs_host_agent', detail: NEEDS_AGENT },
    { id: 'tailscale', label: 'Tailscale', state: 'needs_host_agent', detail: NEEDS_AGENT },
    pub,
    tunnel,
  ];
}

export function buildOverview(d: ViewDeps): Overview {
  const now = d.clock();
  const projects = listProjects(d.db);
  const c = containersResponse(d, projects);
  // If stored history cannot be read, show what is still known and say so, instead of failing the page.
  let readFailed = false;
  const guarded = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      readFailed = true;
      return fallback;
    }
  };
  const noCheck = checkStatus(
    d.db,
    { id: '', healthUrl: null, healthAllowPrivate: false },
    d.provider.source,
    now,
    d.cfg.healthIntervalMs,
  );
  const statuses = projects.map((p) => guarded(() => httpFor(d, p), noCheck));

  const sample = guarded(() => latestSample(d.db, d.provider.source), undefined);
  const host: Reading<NonNullable<Overview['host']['data']>> = {
    freshness: freshness(sample?.ts ?? null, now, d.cfg.pollIntervalMs),
    collectedAt: iso(sample?.ts ?? null),
    source: d.provider.source,
    data: sample?.host ?? null,
  };
  const docker: Overview['docker'] = {
    freshness: c.freshness,
    collectedAt: c.collectedAt,
    source: d.provider.source,
    data: c.freshness === 'unavailable' ? null : summarizeContainers(c.items),
  };
  const err = (e: { at: number; message: string } | null): SourceError | null =>
    e ? { at: iso(e.at)!, message: e.message } : null;

  return {
    mode: d.provider.source,
    generatedAt: iso(now)!,
    pollIntervalMs: d.cfg.pollIntervalMs,
    host,
    docker,
    netdata: netdataReading(d),
    projects: projects.map((p, i) => ({
      id: p.id,
      name: p.name,
      desiredState: p.desiredState,
      health: healthFor(p, c, statuses[i]!),
      httpCheck: statuses[i]!.state,
    })),
    connectivity: buildConnectivity(c, statuses),
    collectorErrors: {
      host: err(d.collector.errors.host),
      docker: err(d.collector.errors.docker),
      storage:
        err(d.collector.errors.storage) ??
        (readFailed ? { at: iso(now)!, message: 'Stored history could not be read' } : null),
    },
    deployments: { available: false, reason: 'Deployment history arrives in Phase 5' },
    alerts: { available: false, reason: 'Alert rules and incidents arrive in Phase 4' },
  };
}
