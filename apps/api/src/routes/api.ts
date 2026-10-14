import { Router } from 'express';
import { z } from 'zod';
import { freshness, projectInputSchema, type MetricsHistory } from '@hlcc/shared';
import type { Ctx } from '../context.ts';
import {
  HttpError,
  currentSession,
  requireAuth,
  requireCsrf,
  type AuthedSession,
} from '../middleware.ts';
import { recordAudit, listAudit } from '../repositories/audit.ts';
import { history, latestSample } from '../repositories/metrics.ts';
import {
  getProject,
  insertProject,
  listProjects,
  updateProject,
} from '../repositories/projects.ts';
import { buildOverview, containersResponse, projectView } from '../services/views.ts';

const MAX_SSE_CLIENTS = 20;
const PATCHABLE = [
  'name',
  'description',
  'repoUrl',
  'deploymentDir',
  'environment',
  'desiredState',
  'healthUrl',
  'containers',
];
const patchSchema = projectInputSchema.omit({ id: true, capabilities: true }).partial();
const idParam = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);
const containerParam = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

const notAvailable = (reason: string) => ({ available: false, reason, items: [] });

export function apiRouter(ctx: Ctx): Router {
  const router = Router();
  const views = () => ({
    cfg: ctx.cfg,
    db: ctx.db,
    clock: ctx.clock,
    provider: ctx.provider,
    collector: ctx.collector,
  });
  const audit = (a: Parameters<typeof recordAudit>[1]) => recordAudit(ctx.db, a, ctx.clock());
  let sseClients = 0;

  // Public liveness probe: no details, so it is safe behind any proxy.
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));

  router.use(requireAuth(ctx), requireCsrf);

  router.get('/overview', (_req, res) => res.json(buildOverview(views())));

  router.get('/metrics/current', (_req, res) => res.json(buildOverview(views()).host));

  router.get('/metrics/history', (req, res) => {
    const q = z
      .object({
        minutes: z.coerce
          .number()
          .int()
          .min(1)
          .max(Math.floor(ctx.cfg.retentionMs / 60_000))
          .default(60),
        limit: z.coerce.number().int().min(10).max(1000).default(240),
      })
      .parse(req.query);
    const now = ctx.clock();
    const source = ctx.provider.source;
    const latest = latestSample(ctx.db, source);
    res.json({
      source,
      freshness: freshness(latest?.ts ?? null, now, ctx.cfg.pollIntervalMs),
      collectedAt: latest ? new Date(latest.ts).toISOString() : null,
      units: { cpu: '%', memory: 'bytes' },
      from: now - q.minutes * 60_000,
      to: now,
      points: history(ctx.db, source, now - q.minutes * 60_000, q.limit),
    } satisfies MetricsHistory);
  });

  router.get('/projects', (_req, res) => {
    const c = containersResponse(views());
    res.json({ items: listProjects(ctx.db).map((p) => projectView(p, c)) });
  });

  router.get('/projects/:id', (req, res) => {
    const p = getProject(ctx.db, idParam.parse(req.params.id));
    if (!p) throw new HttpError(404, 'not_found', 'Project not found');
    res.json(projectView(p, containersResponse(views())));
  });

  router.get('/projects/:id/health', (req, res) => {
    const p = getProject(ctx.db, idParam.parse(req.params.id));
    if (!p) throw new HttpError(404, 'not_found', 'Project not found');
    const v = projectView(p, containersResponse(views()));
    res.json({ health: v.health, freshness: v.freshness, httpCheck: v.healthCheck });
  });

  router.post('/projects', (req, res) => {
    const session = res.locals.session as AuthedSession;
    const input = projectInputSchema.parse(req.body);
    if (input.capabilities.some((c) => c !== 'monitor')) {
      throw new HttpError(
        400,
        'capability_not_enabled',
        'Only the monitor capability is available in this release',
      );
    }
    if (!insertProject(ctx.db, input, ctx.clock()))
      throw new HttpError(409, 'conflict', 'Project id already exists');
    audit({
      actor: session.username,
      action: 'project.create',
      target: input.id,
      outcome: 'success',
      ip: req.ip,
    });
    res.status(201).json(projectView(getProject(ctx.db, input.id)!, containersResponse(views())));
  });

  router.patch('/projects/:id', (req, res) => {
    const session = res.locals.session as AuthedSession;
    const id = idParam.parse(req.params.id);
    const raw = z.record(z.string(), z.unknown()).parse(req.body);
    const unknown = Object.keys(raw).filter((k) => !PATCHABLE.includes(k));
    if (unknown.length)
      throw new HttpError(400, 'field_not_editable', `Not editable: ${unknown.join(', ')}`);
    // Pick only submitted keys: Zod would otherwise re-apply schema defaults to omitted fields.
    const parsed = patchSchema.parse(raw) as Record<string, unknown>;
    const patch = Object.fromEntries(Object.keys(raw).map((k) => [k, parsed[k]]));
    const updated = updateProject(ctx.db, id, patch, ctx.clock());
    if (!updated) throw new HttpError(404, 'not_found', 'Project not found');
    audit({
      actor: session.username,
      action: 'project.update',
      target: id,
      outcome: 'success',
      ip: req.ip,
      detail: { fields: Object.keys(patch) },
    });
    res.json(projectView(updated, containersResponse(views())));
  });

  router.get('/containers', (_req, res) => res.json(containersResponse(views())));

  router.get('/containers/:id', (req, res) => {
    const key = containerParam.parse(req.params.id);
    const item = containersResponse(views()).items.find((c) => c.id === key || c.name === key);
    if (!item) throw new HttpError(404, 'not_found', 'Container not found');
    res.json(item);
  });

  router.get('/events', (_req, res) =>
    res.json(notAvailable('Docker events arrive with the Phase 3 adapter')),
  );
  router.get('/deployments', (_req, res) =>
    res.json(notAvailable('Deployment history arrives in Phase 5')),
  );
  router.get('/alerts', (_req, res) =>
    res.json(notAvailable('Alert rules and incidents arrive in Phase 4')),
  );

  router.get('/audit', (req, res) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const items = listAudit(ctx.db, q.limit, q.before);
    res.json({ items, nextBefore: items.length === q.limit ? items[items.length - 1]!.id : null });
  });

  // Server-Sent Events: a tiny "something changed" signal; clients refetch through the normal API.
  router.get('/stream', (req, res) => {
    if (sseClients >= MAX_SSE_CLIENTS)
      throw new HttpError(503, 'too_many_streams', 'Too many open streams');
    sseClients++;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');

    const onUpdate = () =>
      res.write(`event: update\ndata: ${JSON.stringify({ at: ctx.clock() })}\n\n`);
    const heartbeat = setInterval(() => {
      if (!currentSession(ctx, req)) return res.end(); // session expired or signed out
      res.write(': keep-alive\n\n');
    }, 25_000);
    ctx.collector.on('update', onUpdate);
    req.on('close', () => {
      clearInterval(heartbeat);
      ctx.collector.off('update', onUpdate);
      sseClients--;
    });
  });

  return router;
}
