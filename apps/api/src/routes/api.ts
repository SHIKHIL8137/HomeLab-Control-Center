import { Router } from 'express';
import { z } from 'zod';
import {
  freshness,
  projectInputSchema,
  type MetricsHistory,
  type ProjectInput,
} from '@hlcc/shared';
import type { Ctx } from '../context.ts';
import {
  HttpError,
  currentSession,
  requireAuth,
  requireCsrf,
  type AuthedSession,
} from '../middleware.ts';
import { recordAudit, listAudit } from '../repositories/audit.ts';
import { listEvents } from '../repositories/events.ts';
import { history, latestSample } from '../repositories/metrics.ts';
import { validateTarget } from '../security/ssrf.ts';
import {
  getProject,
  insertProject,
  listProjects,
  updateProject,
} from '../repositories/projects.ts';
import { describeNetwork } from '../services/network.ts';
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
  'healthAllowPrivate',
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

  // Read-only help for choosing HLCC_TRUST_PROXY: shows how this very request arrived.
  router.get('/network', (req, res) => {
    res.json(
      describeNetwork(
        req.socket.remoteAddress,
        req.headers['x-forwarded-for'],
        ctx.cfg.trustProxy,
        req.ip,
      ),
    );
  });

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
    res.json({ items: listProjects(ctx.db).map((p) => projectView(views(), p, c)) });
  });

  router.get('/projects/:id', (req, res) => {
    const p = getProject(ctx.db, idParam.parse(req.params.id));
    if (!p) throw new HttpError(404, 'not_found', 'Project not found');
    res.json(projectView(views(), p, containersResponse(views())));
  });

  router.get('/projects/:id/health', (req, res) => {
    const p = getProject(ctx.db, idParam.parse(req.params.id));
    if (!p) throw new HttpError(404, 'not_found', 'Project not found');
    const v = projectView(views(), p, containersResponse(views()));
    res.json({ health: v.health, freshness: v.freshness, httpCheck: v.httpCheck });
  });

  /** The URL is checked here for early feedback; guardedGet() enforces the policy on every connection. */
  const assertHealthTarget = (url: string | null, allowPrivate: boolean) => {
    if (!url) return;
    const v = validateTarget(url, allowPrivate);
    if (!v.ok) throw new HttpError(400, 'health_target_rejected', v.message);
  };

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
    assertHealthTarget(input.healthUrl, input.healthAllowPrivate);
    if (!insertProject(ctx.db, input, ctx.clock()))
      throw new HttpError(409, 'conflict', 'Project id already exists');
    audit({
      actor: session.username,
      action: 'project.create',
      target: input.id,
      outcome: 'success',
      ip: req.ip,
    });
    if (input.healthAllowPrivate) {
      audit({
        actor: session.username,
        action: 'project.health_private_target',
        target: input.id,
        outcome: 'success',
        ip: req.ip,
        detail: { allowed: true },
      });
    }
    if (input.healthUrl) void ctx.checker.runProject(input.id);
    res
      .status(201)
      .json(projectView(views(), getProject(ctx.db, input.id)!, containersResponse(views())));
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
    const patch = Object.fromEntries(Object.keys(raw).map((k) => [k, parsed[k]])) as Partial<
      Omit<ProjectInput, 'id' | 'capabilities'>
    >;
    const current = getProject(ctx.db, id);
    if (!current) throw new HttpError(404, 'not_found', 'Project not found');
    const nextUrl = patch.healthUrl !== undefined ? patch.healthUrl : current.healthUrl;
    const nextPrivate =
      patch.healthAllowPrivate !== undefined
        ? patch.healthAllowPrivate
        : current.healthAllowPrivate;
    assertHealthTarget(nextUrl, nextPrivate);

    const updated = updateProject(ctx.db, id, patch, ctx.clock())!;
    audit({
      actor: session.username,
      action: 'project.update',
      target: id,
      outcome: 'success',
      ip: req.ip,
      detail: { fields: Object.keys(patch) },
    });
    if (nextPrivate !== current.healthAllowPrivate) {
      // Granting or withdrawing permission to reach private addresses is recorded on its own.
      audit({
        actor: session.username,
        action: 'project.health_private_target',
        target: id,
        outcome: 'success',
        ip: req.ip,
        detail: { allowed: nextPrivate },
      });
    }
    if (nextUrl !== current.healthUrl || nextPrivate !== current.healthAllowPrivate) {
      if (nextUrl) void ctx.checker.runProject(id);
    }
    res.json(projectView(views(), updated, containersResponse(views())));
  });

  router.get('/containers', (_req, res) => res.json(containersResponse(views())));

  router.get('/containers/:id', (req, res) => {
    const key = containerParam.parse(req.params.id);
    const item = containersResponse(views()).items.find((c) => c.id === key || c.name === key);
    if (!item) throw new HttpError(404, 'not_found', 'Container not found');
    res.json(item);
  });

  router.get('/events', (req, res) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const items = listEvents(ctx.db, ctx.provider.source, q.limit, q.before);
    res.json({
      available: true,
      source: ctx.provider.source,
      note: 'Best-effort: Docker replays only a small recent buffer, so events can be missed.',
      items,
      nextBefore: items.length === q.limit ? items[items.length - 1]!.id : null,
    });
  });
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

    // The stream only says "something changed"; a slow client simply misses some nudges and refetches.
    let dropped = 0;
    const send = (chunk: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableNeedDrain) {
        // Backpressure: never queue behind a client that is not reading.
        if (++dropped > 50) res.destroy();
        return;
      }
      dropped = 0;
      res.write(chunk);
    };
    const alive = () => Boolean(currentSession(ctx, req));
    const onUpdate = () => {
      if (!alive()) return res.end(); // signed out or expired: stop sending
      send(`event: update\ndata: ${JSON.stringify({ at: ctx.clock() })}\n\n`);
    };
    const onShutdown = () => res.end();
    const heartbeat = setInterval(() => {
      if (!alive()) return res.end();
      send(': keep-alive\n\n');
    }, 25_000);
    ctx.collector.on('update', onUpdate);
    ctx.collector.on('shutdown', onShutdown);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      ctx.collector.off('update', onUpdate);
      ctx.collector.off('shutdown', onShutdown);
      sseClients--;
    };
    // "close" on the response fires however the stream ends: client left, we ended it, socket failed.
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}
