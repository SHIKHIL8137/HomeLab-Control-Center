import { timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@hlcc/shared';
import type { Ctx } from './context.ts';
import { getSession, type SessionInfo } from './repositories/auth.ts';

export const SESSION_COOKIE = 'hlcc_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AuthedSession = SessionInfo & { token: string };

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } } satisfies ApiError);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function currentSession(ctx: Ctx, req: Request): AuthedSession | undefined {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token) return undefined;
  const s = getSession(ctx.db, token, ctx.clock());
  return s ? { ...s, token } : undefined;
}

const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Rejects cross-origin browser writes. Requests without an Origin header (curl, tests) rely on SameSite cookies. */
export function originGuard(ctx: Ctx) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    // Browsers state where a request came from; a cross-site write is refused even without an Origin.
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return sendError(res, 403, 'origin_not_allowed', 'Cross-site request rejected');
    }
    const origin = req.headers.origin;
    if (!origin) return next();
    const allowed = [`${req.protocol}://${req.get('host')}`, ...ctx.cfg.allowedOrigins];
    if (allowed.includes(origin)) return next();
    sendError(res, 403, 'origin_not_allowed', 'Cross-origin request rejected');
  };
}

export function requireAuth(ctx: Ctx) {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = currentSession(ctx, req);
    if (!session) return sendError(res, 401, 'unauthenticated', 'Sign in required');
    res.locals.session = session;
    next();
  };
}

/** Double protection for writes: SameSite=Strict cookie plus a per-session token in a header. */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const session = res.locals.session as AuthedSession;
  const header = req.get('x-csrf-token') ?? '';
  if (!safeEqual(header, session.csrfToken)) {
    return sendError(res, 403, 'csrf_invalid', 'Missing or invalid CSRF token');
  }
  next();
}

export const errorHandler =
  (ctx: Ctx): ErrorRequestHandler =>
  (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      } satisfies ApiError);
      return;
    }
    if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
    const type = (err as { type?: string }).type;
    if (type === 'entity.too.large')
      return sendError(res, 413, 'payload_too_large', 'Request body too large');
    if (type === 'entity.parse.failed')
      return sendError(res, 400, 'invalid_json', 'Malformed JSON body');
    ctx.log.error({ err, path: req.path }, 'unhandled error');
    sendError(res, 500, 'internal_error', 'Internal server error');
  };
