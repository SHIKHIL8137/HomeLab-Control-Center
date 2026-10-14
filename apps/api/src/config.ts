import { z } from 'zod';
import { fileURLToPath } from 'node:url';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  HLCC_MODE: z.enum(['mock', 'live']).default('mock'),
  HLCC_HOST: z.string().default('127.0.0.1'),
  HLCC_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HLCC_DATA_DIR: z.string().min(1).default('./data'),
  HLCC_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  HLCC_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(48),
  HLCC_COOKIE_SECURE: bool,
  HLCC_TRUST_PROXY: bool,
  HLCC_SETUP_TOKEN: z.string().min(16).optional(),
  HLCC_ALLOWED_ORIGINS: z.string().default(''),
  HLCC_WEB_DIST: z.string().optional(),
  HLCC_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export interface Config {
  mode: 'mock' | 'live';
  host: string;
  port: number;
  dataDir: string;
  migrationsDir: string;
  pollIntervalMs: number;
  retentionMs: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  setupToken?: string;
  allowedOrigins: string[];
  webDist?: string;
  logLevel: string;
  sessionTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  return {
    mode: e.HLCC_MODE,
    host: e.HLCC_HOST,
    port: e.HLCC_PORT,
    dataDir: e.HLCC_DATA_DIR,
    migrationsDir: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    pollIntervalMs: e.HLCC_POLL_INTERVAL_MS,
    retentionMs: e.HLCC_RETENTION_HOURS * 3_600_000,
    cookieSecure: e.HLCC_COOKIE_SECURE,
    trustProxy: e.HLCC_TRUST_PROXY,
    setupToken: e.HLCC_SETUP_TOKEN,
    allowedOrigins: e.HLCC_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webDist: e.HLCC_WEB_DIST,
    logLevel: e.HLCC_LOG_LEVEL,
    sessionTtlMs: 12 * 3_600_000,
  };
}
