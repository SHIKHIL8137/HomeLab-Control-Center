import {
  deriveProjectHealth,
  freshness,
  summarizeContainers,
  type ContainerView,
  type ContainersResponse,
  type Overview,
  type Project,
  type ProjectHealth,
  type ProjectView,
  type Reading,
  type StopIntent,
} from '@hlcc/shared';
import type { Config } from '../config.ts';
import type { Clock, Db } from '../db.ts';
import type { Provider } from '../providers/types.ts';
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
  return { freshness: fresh, collectedAt: iso(snap?.at ?? null), source: d.provider.source, items };
}

function healthFor(p: Project, c: ContainersResponse): ProjectHealth {
  // Stale or missing data must never read as healthy.
  if (c.freshness === 'stale') return { status: 'unknown', reason: 'Container data is stale' };
  return deriveProjectHealth(p, c.freshness === 'current' ? c.items : null);
}

export function projectView(p: Project, c: ContainersResponse): ProjectView {
  return {
    ...p,
    health: healthFor(p, c),
    containersObserved: c.items.filter((i) => p.containers.includes(i.name)),
    freshness: c.freshness,
    healthCheck: {
      available: false,
      reason: p.healthUrl
        ? 'HTTP health checks arrive with the Phase 3 adapters; this URL is stored but not probed'
        : 'No health URL configured',
    },
  };
}

export function buildOverview(d: ViewDeps): Overview {
  const now = d.clock();
  const projects = listProjects(d.db);
  const c = containersResponse(d, projects);

  const sample = latestSample(d.db, d.provider.source);
  const host: Reading<Overview['host']['data'] & object> = {
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
  const err = d.collector.lastError;
  return {
    mode: d.provider.source,
    generatedAt: iso(now)!,
    pollIntervalMs: d.cfg.pollIntervalMs,
    host,
    docker,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      desiredState: p.desiredState,
      health: healthFor(p, c),
    })),
    collectorError: err ? { at: iso(err.at)!, message: err.message } : null,
    deployments: { available: false, reason: 'Deployment history arrives in Phase 5' },
    alerts: { available: false, reason: 'Alert rules and incidents arrive in Phase 4' },
  };
}
