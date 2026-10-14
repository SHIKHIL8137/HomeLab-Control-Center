import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { createLiveProvider } from './providers/live.ts';
import { createMockProvider } from './providers/mock.ts';
import { countProjects, insertProject } from './repositories/projects.ts';
import { userCount } from './repositories/auth.ts';
import { FailureLimiter } from './security/rateLimit.ts';
import { Collector } from './services/collector.ts';
import { SEED_PROJECTS } from './seed/projects.ts';

const cfg = loadConfig();
const clock = () => Date.now();
const log = pino({
  level: cfg.logLevel,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
});

const db = openDb(cfg.dataDir);
const applied = migrate(db, cfg.migrationsDir);
if (applied.length) log.info({ applied }, 'migrations applied');
if (countProjects(db) === 0) {
  for (const p of SEED_PROJECTS) insertProject(db, p, clock());
  log.info({ count: SEED_PROJECTS.length }, 'seeded project registry');
}

const provider = cfg.mode === 'mock' ? createMockProvider(clock) : createLiveProvider();
const collector = new Collector({
  provider,
  db,
  clock,
  log,
  pollIntervalMs: cfg.pollIntervalMs,
  retentionMs: cfg.retentionMs,
});

const setupToken = cfg.setupToken ?? randomBytes(18).toString('base64url');
if (userCount(db) === 0) {
  // A generated token is printed once so only someone with log access can claim the admin account.
  // A token supplied through HLCC_SETUP_TOKEN is never echoed.
  log.warn(
    cfg.setupToken
      ? 'First-run setup required. Use the token from HLCC_SETUP_TOKEN.'
      : `First-run setup required. Setup token: ${setupToken}`,
  );
}

const app = createApp({
  cfg,
  db,
  clock,
  log,
  provider,
  collector,
  setupToken,
  limiter: new FailureLimiter(5, 15 * 60_000, clock),
});

collector.start();
const server = app.listen(cfg.port, cfg.host, () => {
  log.info(
    { mode: cfg.mode, host: cfg.host, port: cfg.port },
    'HomeLab Control Center API listening',
  );
});

const shutdown = () => {
  collector.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
