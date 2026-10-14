import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { migrate, openDb } from '../src/db.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import type { Provider } from '../src/providers/types.ts';
import { insertProject } from '../src/repositories/projects.ts';
import { FailureLimiter } from '../src/security/rateLimit.ts';
import { Collector } from '../src/services/collector.ts';
import { SEED_PROJECTS } from '../src/seed/projects.ts';

export const SETUP_TOKEN = 'test-setup-token-123456';
export const PASSWORD = 'correct horse battery';

export function makeApp(opts: { provider?: Provider; env?: Record<string, string> } = {}) {
  const time = { t: Date.UTC(2026, 9, 14, 12, 0, 0) };
  const clock = () => time.t;
  const cfg = loadConfig({
    HLCC_DATA_DIR: ':memory:',
    HLCC_LOG_LEVEL: 'silent',
    HLCC_POLL_INTERVAL_MS: '15000',
    ...opts.env,
  });
  const db = openDb(':memory:');
  migrate(db, cfg.migrationsDir);
  for (const p of SEED_PROJECTS) insertProject(db, p, clock());
  const log = pino({ level: 'silent' });
  const provider = opts.provider ?? createMockProvider(clock);
  const collector = new Collector({
    provider,
    db,
    clock,
    log,
    pollIntervalMs: cfg.pollIntervalMs,
    retentionMs: cfg.retentionMs,
  });
  const ctx = {
    cfg,
    db,
    clock,
    log,
    provider,
    collector,
    setupToken: SETUP_TOKEN,
    limiter: new FailureLimiter(5, 15 * 60_000, clock),
  };
  return { app: createApp(ctx), ctx, time, collector, db };
}

/** Completes first-run setup and returns an agent holding the session cookie plus its CSRF token. */
export async function signedIn(h: ReturnType<typeof makeApp>) {
  const agent = request.agent(h.app);
  const res = await agent
    .post('/api/v1/auth/setup')
    .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
  if (res.status !== 201)
    throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const status = await agent.get('/api/v1/auth/status');
  return { agent, csrf: status.body.csrfToken as string };
}
