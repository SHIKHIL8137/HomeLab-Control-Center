import type { Logger } from 'pino';
import type { Config } from './config.ts';
import type { Clock, Db } from './db.ts';
import type { Provider } from './providers/types.ts';
import type { FailureLimiter } from './security/rateLimit.ts';
import type { Collector } from './services/collector.ts';
import type { HealthChecker } from './services/healthChecker.ts';

export interface Ctx {
  cfg: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  provider: Provider;
  collector: Collector;
  checker: HealthChecker;
  limiter: FailureLimiter;
  /** One-time secret required for first-run setup. */
  setupToken: string;
  /** Called once the administrator account has been created. */
  onSetupComplete?: () => void;
}
