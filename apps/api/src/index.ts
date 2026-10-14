import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { createLiveProvider } from './providers/live.ts';
import { createMockProvider } from './providers/mock.ts';
import { userCount } from './repositories/auth.ts';
import { countProjects, insertProject } from './repositories/projects.ts';
import { FailureLimiter } from './security/rateLimit.ts';
import { SEED_PROJECTS } from './seed/projects.ts';
import { Collector } from './services/collector.ts';
import { HealthChecker, liveFetcher, mockFetcher } from './services/healthChecker.ts';

const clock = () => Date.now();
const bootLog = pino({ level: 'info' });

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  // Configuration errors name the variable at fault; they never contain a secret value.
  bootLog.fatal(`Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

const log = pino({
  level: cfg.logLevel,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
});
if (cfg.production && !cfg.cookieSecure) {
  log.warn('Cookies are not marked Secure (HLCC_ALLOW_INSECURE_COOKIES is set); serve over HTTPS');
}

const db = openDb(cfg.dataDir);
const applied = migrate(db, cfg.migrationsDir);
if (applied.length) log.info({ applied }, 'migrations applied');
if (countProjects(db) === 0) {
  for (const p of SEED_PROJECTS) insertProject(db, p, clock());
  log.info({ count: SEED_PROJECTS.length }, 'seeded project registry');
}

// Mock and live are separate worlds: live mode has no path to demo data.
const provider = cfg.mode === 'mock' ? createMockProvider(clock) : createLiveProvider(cfg, clock);
const collector = new Collector({
  provider,
  db,
  clock,
  log,
  pollIntervalMs: cfg.pollIntervalMs,
  retentionMs: cfg.retentionMs,
});
const checker = new HealthChecker({
  db,
  clock,
  log,
  source: provider.source,
  fetcher: cfg.mode === 'mock' ? mockFetcher() : liveFetcher(),
  intervalMs: cfg.healthIntervalMs,
  retentionMs: cfg.retentionMs,
  concurrency: cfg.healthConcurrency,
  notify: () => collector.emit('update'),
});

// First-run setup. The one-time token is never written to the log.
const tokenFile = join(cfg.dataDir, 'setup-token');
const removeTokenFile = () => rmSync(tokenFile, { force: true });
let setupToken: string;
if (userCount(db) > 0) {
  removeTokenFile(); // setup is finished; a leftover token file would be misleading
  setupToken = randomBytes(32).toString('base64url'); // unused: setup is refused once a user exists
} else if (cfg.setupToken) {
  setupToken = cfg.setupToken;
  log.warn('First-run setup required. Use the configured setup token.');
} else if (cfg.production) {
  log.fatal(
    'Refusing to start: first-run setup needs HLCC_SETUP_TOKEN or HLCC_SETUP_TOKEN_FILE in production',
  );
  process.exit(1);
} else {
  // Development convenience: a generated token goes to a private file, and only its path is logged.
  setupToken = randomBytes(18).toString('base64url');
  writeFileSync(tokenFile, `${setupToken}\n`, { mode: 0o600 });
  log.warn(
    { file: tokenFile },
    'First-run setup required. The one-time setup token is in this file',
  );
}

const app = createApp({
  cfg,
  db,
  clock,
  log,
  provider,
  collector,
  checker,
  setupToken,
  onSetupComplete: removeTokenFile,
  limiter: new FailureLimiter(5, 15 * 60_000, clock),
});

collector.start();
checker.start();
const server = app.listen(cfg.port, cfg.host, () => {
  log.info(
    { mode: cfg.mode, host: cfg.host, port: cfg.port },
    'HomeLab Control Center API listening',
  );
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down');
  collector.stop();
  checker.stop();
  collector.emit('shutdown'); // ends open event streams
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  // Open streams and slow clients must not keep the process alive past the container's grace period.
  setTimeout(() => server.closeAllConnections(), 3_000).unref();
  setTimeout(() => process.exit(1), 8_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// A bug or I/O failure in a background task must be logged, not silently kill the monitor.
process.on('unhandledRejection', (reason) => {
  log.error(
    { err: reason instanceof Error ? reason.message : String(reason) },
    'unhandled rejection',
  );
});
