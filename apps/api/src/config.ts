import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { diskConfigSchema, type DiskConfig } from './providers/host.ts';
import { validateTarget } from './security/ssrf.ts';

/** Compose passes unset variables as empty strings; treat those as "not set". */
const optional = <T extends z.ZodType>(inner: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), inner.optional());

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/** Number of reverse proxies in front of the app whose X-Forwarded-For we trust (0 = none). */
const proxyHops = z
  .string()
  .default('0')
  .transform((v) => (v === 'true' ? '1' : v === 'false' ? '0' : v))
  .transform(Number)
  .pipe(z.number().int().min(0).max(3));

export const MIN_DOCKER_TOKEN_LENGTH = 32;
const MIN_DISTINCT_CHARS = 12;
const TOKEN_FORMAT = /^[A-Za-z0-9._~+/=-]+$/;

const schema = z.object({
  NODE_ENV: z.string().optional(),
  HLCC_MODE: z.enum(['mock', 'live']).default('mock'),
  HLCC_HOST: z.string().default('127.0.0.1'),
  HLCC_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HLCC_DATA_DIR: z.string().min(1).default('./data'),
  // Docker is asked about every container on each poll, so a floor protects the host.
  HLCC_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(15_000),
  HLCC_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(48),
  HLCC_COOKIE_SECURE: bool,
  /** Production refuses non-Secure cookies unless this is set on purpose. */
  HLCC_ALLOW_INSECURE_COOKIES: bool,
  HLCC_TRUST_PROXY: proxyHops,
  HLCC_ALLOWED_ORIGINS: z.string().default(''),
  HLCC_WEB_DIST: optional(z.string()),
  // Live integrations. Everything is unset by default; nothing is probed until it is configured.
  HLCC_DOCKER_URL: optional(z.string()),
  HLCC_DISKS: optional(z.string()),
  HLCC_HOST_PROC_ASSERT: bool,
  HLCC_NETDATA_URL: optional(z.string()),
  HLCC_HEALTH_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  HLCC_HEALTH_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  HLCC_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export interface Config {
  production: boolean;
  mode: 'mock' | 'live';
  host: string;
  port: number;
  dataDir: string;
  migrationsDir: string;
  pollIntervalMs: number;
  retentionMs: number;
  cookieSecure: boolean;
  trustProxy: number;
  /** One-time first-run secret. Never logged; see index.ts for how a missing one is handled. */
  setupToken?: string;
  allowedOrigins: string[];
  webDist?: string;
  dockerUrl?: string;
  /** Shared secret for the Docker proxy. Required whenever dockerUrl is set. */
  dockerToken?: string;
  disks: DiskConfig[];
  hostProcAssert: boolean;
  netdataUrl?: string;
  healthIntervalMs: number;
  healthConcurrency: number;
  logLevel: string;
  sessionTtlMs: number;
}

/**
 * A secret comes from NAME or from the file named by NAME_FILE (preferred: file contents stay out
 * of `docker inspect` and process listings). Messages name the variable, never the value.
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name] === '' ? undefined : env[name];
  const file = env[`${name}_FILE`] === '' ? undefined : env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Set only one of ${name} and ${name}_FILE`);
  }
  if (file === undefined) return direct;
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    throw new Error(`${name}_FILE could not be read`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const production = e.NODE_ENV === 'production';

  const setupToken = readSecret(env, 'HLCC_SETUP_TOKEN');
  if (setupToken !== undefined && setupToken.length < 16) {
    throw new Error('HLCC_SETUP_TOKEN must be at least 16 characters');
  }

  const dockerToken = readSecret(env, 'HLCC_DOCKER_TOKEN');
  if (e.HLCC_DOCKER_URL) {
    assertUrl('HLCC_DOCKER_URL', e.HLCC_DOCKER_URL, (u) => u.protocol === 'http:');
    // Fail closed: an unauthenticated proxy connection is never configured silently.
    if (dockerToken === undefined) {
      throw new Error('HLCC_DOCKER_URL is set but HLCC_DOCKER_TOKEN (or _FILE) is missing');
    }
  }
  if (
    dockerToken !== undefined &&
    (dockerToken.length < MIN_DOCKER_TOKEN_LENGTH || !TOKEN_FORMAT.test(dockerToken))
  ) {
    throw new Error(
      `HLCC_DOCKER_TOKEN must be at least ${MIN_DOCKER_TOKEN_LENGTH} characters of [A-Za-z0-9._~+/=-]`,
    );
  }

  if (dockerToken !== undefined && new Set(dockerToken).size < MIN_DISTINCT_CHARS) {
    // Long but repetitive ("AAAA...") is trivially guessable.
    throw new Error('HLCC_DOCKER_TOKEN is too repetitive; generate it randomly');
  }

  if (e.HLCC_NETDATA_URL) {
    assertUrl(
      'HLCC_NETDATA_URL',
      e.HLCC_NETDATA_URL,
      () => validateTarget(e.HLCC_NETDATA_URL!, true).ok,
    );
  }

  if (production && !e.HLCC_COOKIE_SECURE && !e.HLCC_ALLOW_INSECURE_COOKIES) {
    throw new Error(
      'Production requires HLCC_COOKIE_SECURE=true (serve over HTTPS), or HLCC_ALLOW_INSECURE_COOKIES=true to accept the risk',
    );
  }

  return {
    production,
    mode: e.HLCC_MODE,
    host: e.HLCC_HOST,
    port: e.HLCC_PORT,
    dataDir: e.HLCC_DATA_DIR,
    migrationsDir: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    pollIntervalMs: e.HLCC_POLL_INTERVAL_MS,
    retentionMs: e.HLCC_RETENTION_HOURS * 3_600_000,
    cookieSecure: e.HLCC_COOKIE_SECURE,
    trustProxy: e.HLCC_TRUST_PROXY,
    ...(setupToken !== undefined ? { setupToken } : {}),
    allowedOrigins: e.HLCC_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(e.HLCC_WEB_DIST ? { webDist: e.HLCC_WEB_DIST } : {}),
    ...(e.HLCC_DOCKER_URL ? { dockerUrl: e.HLCC_DOCKER_URL } : {}),
    ...(dockerToken !== undefined ? { dockerToken } : {}),
    disks: parseDisks(e.HLCC_DISKS),
    hostProcAssert: e.HLCC_HOST_PROC_ASSERT,
    ...(e.HLCC_NETDATA_URL ? { netdataUrl: e.HLCC_NETDATA_URL } : {}),
    healthIntervalMs: e.HLCC_HEALTH_INTERVAL_MS,
    healthConcurrency: e.HLCC_HEALTH_CONCURRENCY,
    logLevel: e.HLCC_LOG_LEVEL,
    sessionTtlMs: 12 * 3_600_000,
  };
}

function assertUrl(name: string, value: string, ok: (u: URL) => boolean): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (u.username || u.password || !ok(u)) throw new Error(`${name} is not acceptable`);
}

function parseDisks(raw: string | undefined): DiskConfig[] {
  if (!raw) return [];
  try {
    return diskConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('HLCC_DISKS must be a JSON array of {label, path, separate?}');
  }
}
