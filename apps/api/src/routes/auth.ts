import { timingSafeEqual } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthStatus } from '@hlcc/shared';
import type { Ctx } from '../context.ts';
import {
  SESSION_COOKIE,
  currentSession,
  readCookie,
  requireAuth,
  requireCsrf,
  sendError,
  type AuthedSession,
} from '../middleware.ts';
import {
  createFirstUser,
  createSession,
  deleteSession,
  getUserByUsername,
  updatePasswordHash,
  userCount,
} from '../repositories/auth.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  needsRehash,
  PASSWORD_MAX,
  PASSWORD_MIN,
  dummyHash,
  hashPassword,
  verifyPassword,
} from '../security/password.ts';

const username = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9_.@-]+$/, 'letters, digits and . _ @ -');
const setupBody = z.object({
  setupToken: z.string().min(1).max(200),
  username,
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
});
const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX),
});

/**
 * The audit trail records what the server established, not what a client claims: failed attempts are
 * attributed to "anonymous" and the submitted name is kept only as a clearly labelled, cleaned detail.
 */
const attempted = (name: string) => name.replace(/[^ -~]/g, '?').slice(0, 64);

const tokenMatches = (given: string, expected: string) =>
  given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

export function authRouter(ctx: Ctx): Router {
  const router = Router();
  const audit = (a: Parameters<typeof recordAudit>[1]) => recordAudit(ctx.db, a, ctx.clock());

  const startSession = (res: Response, userId: number) => {
    const s = createSession(ctx.db, userId, ctx.clock(), ctx.cfg.sessionTtlMs);
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.cfg.cookieSecure,
      path: '/',
      maxAge: ctx.cfg.sessionTtlMs,
    });
    return s;
  };

  router.get('/status', (req, res) => {
    const session = currentSession(ctx, req);
    res.json({
      mode: ctx.provider.source,
      setupRequired: userCount(ctx.db) === 0,
      authenticated: Boolean(session),
      username: session?.username,
      csrfToken: session?.csrfToken,
    } satisfies AuthStatus);
  });

  router.post('/setup', async (req, res) => {
    const key = `setup:${req.ip}`;
    if (!ctx.limiter.allowed(key)) {
      res.setHeader('Retry-After', ctx.limiter.retryAfterSeconds(key));
      return sendError(res, 429, 'rate_limited', 'Too many attempts, try again later');
    }
    if (userCount(ctx.db) > 0)
      return sendError(res, 409, 'already_configured', 'Setup already completed');
    const body = setupBody.parse(req.body);
    if (!tokenMatches(body.setupToken, ctx.setupToken)) {
      ctx.limiter.fail(key);
      audit({ actor: 'anonymous', action: 'auth.setup', outcome: 'denied', ip: req.ip });
      return sendError(res, 403, 'invalid_setup_token', 'Invalid setup token');
    }
    const userId = createFirstUser(
      ctx.db,
      body.username,
      await hashPassword(body.password),
      ctx.clock(),
    );
    if (userId === null)
      return sendError(res, 409, 'already_configured', 'Setup already completed');
    startSession(res, userId);
    ctx.onSetupComplete?.();
    audit({ actor: body.username, action: 'auth.setup', outcome: 'success', ip: req.ip });
    res.status(201).json({ ok: true });
  });

  router.post('/login', async (req, res) => {
    const body = loginBody.parse(req.body);
    const key = `login:${req.ip}`;
    if (!ctx.limiter.allowed(key)) {
      res.setHeader('Retry-After', ctx.limiter.retryAfterSeconds(key));
      audit({
        actor: 'anonymous',
        action: 'auth.login',
        outcome: 'denied',
        ip: req.ip,
        detail: { reason: 'rate_limited', attemptedUser: attempted(body.username) },
      });
      return sendError(res, 429, 'rate_limited', 'Too many attempts, try again later');
    }
    const user = getUserByUsername(ctx.db, body.username);
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash()));
    if (!user || !ok) {
      ctx.limiter.fail(key);
      audit({
        actor: 'anonymous',
        action: 'auth.login',
        outcome: 'failure',
        ip: req.ip,
        detail: { attemptedUser: attempted(body.username) },
      });
      return sendError(res, 401, 'invalid_credentials', 'Invalid username or password');
    }
    ctx.limiter.reset(key);
    // Never reuse a session across a login, and quietly upgrade an older hash to the current cost.
    const previous = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (previous) deleteSession(ctx.db, previous);
    if (needsRehash(user.password_hash)) {
      updatePasswordHash(ctx.db, user.id, await hashPassword(body.password));
    }
    startSession(res, user.id);
    audit({ actor: user.username, action: 'auth.login', outcome: 'success', ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/logout', requireAuth(ctx), requireCsrf, (req, res) => {
    const session = res.locals.session as AuthedSession;
    deleteSession(ctx.db, readCookie(req.headers.cookie, SESSION_COOKIE) ?? '');
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    audit({ actor: session.username, action: 'auth.logout', outcome: 'success', ip: req.ip });
    res.json({ ok: true });
  });

  return router;
}
