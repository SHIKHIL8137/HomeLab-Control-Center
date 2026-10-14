import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Ctx } from './context.ts';
import { errorHandler, originGuard, sendError } from './middleware.ts';
import { apiRouter } from './routes/api.ts';
import { authRouter } from './routes/auth.ts';

export function createApp(ctx: Ctx): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.cfg.trustProxy);

  app.use(
    helmet({
      // Only force HTTPS when the deployment is actually served over it.
      strictTransportSecurity: ctx.cfg.cookieSecure,
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"], // charts set inline styles
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': ctx.cfg.cookieSecure ? [] : null,
        },
      },
    }),
  );
  app.use(
    pinoHttp({ logger: ctx.log, autoLogging: { ignore: (req) => req.url === '/api/v1/health' } }),
  );
  app.use(express.json({ limit: '10kb' }));
  app.use(originGuard(ctx));

  // Auth endpoints are mounted before the authenticated API router.
  app.use('/api/v1/auth', authRouter(ctx));
  app.use('/api/v1', apiRouter(ctx));
  app.use('/api', (_req, res) => sendError(res, 404, 'not_found', 'Unknown API route'));

  if (ctx.cfg.webDist && existsSync(ctx.cfg.webDist)) {
    const dist = resolve(ctx.cfg.webDist);
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) =>
      req.method === 'GET' ? res.sendFile(resolve(dist, 'index.html')) : next(),
    );
  }

  app.use(errorHandler(ctx));
  return app;
}
