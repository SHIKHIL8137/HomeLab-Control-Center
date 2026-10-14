import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { decide, type Route } from './policy.ts';
import {
  projectEvents,
  projectInfo,
  projectInspect,
  projectList,
  projectStats,
} from './project.ts';

/** Where the real Docker API lives: a unix socket (or Windows named pipe) or a TCP address. */
export type Upstream = { socketPath: string } | { host: string; port: number };

export const MIN_TOKEN_LENGTH = 32;
const MIN_DISTINCT_CHARS = 12;
const TOKEN_FORMAT = /^[A-Za-z0-9._~+/=-]+$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INFLIGHT = 16;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ProxyOptions {
  /** Shared secret every caller must present as "Authorization: Bearer <token>". Required. */
  token: string;
  timeoutMs?: number;
  maxInflight?: number;
}

/** Fails closed: a missing or weak credential is a startup error, never a silent default. */
export function assertValidToken(token: string | undefined): string {
  if (!token || token.length < MIN_TOKEN_LENGTH || !TOKEN_FORMAT.test(token)) {
    throw new Error(
      `The proxy token must be at least ${MIN_TOKEN_LENGTH} characters of [A-Za-z0-9._~+/=-]`,
    );
  }
  // A long string of one repeated character passes a length check but is trivially guessable.
  if (new Set(token).size < MIN_DISTINCT_CHARS) {
    throw new Error(
      'The proxy token is too repetitive; generate it randomly (see docs/deployment.md)',
    );
  }
  return token;
}

/** Both sides are hashed first, so the comparison is constant-time and length leaks nothing. */
const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(header: string | undefined, expected: Buffer): boolean {
  const m = BEARER.exec(header ?? '');
  return m !== null && timingSafeEqual(digest(m[1] as string), expected);
}

function fetchUpstream(
  upstream: Upstream,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...upstream, path, method: 'GET', timeout: timeoutMs, signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX_BODY_BYTES) {
            tooLarge = true;
            reject(new Error('upstream response too large'));
            req.destroy();
            return;
          }
          chunks.push(d);
        });
        res.on('error', reject);
        res.on(
          'end',
          () =>
            tooLarge ||
            resolve({
              status: res.statusCode ?? 502,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

function project(route: Route, body: string): unknown {
  switch (route.kind) {
    case 'info':
      return projectInfo(JSON.parse(body));
    case 'list':
      return projectList(JSON.parse(body));
    case 'inspect':
      return projectInspect(JSON.parse(body));
    case 'stats':
      return projectStats(JSON.parse(body));
    case 'events':
      return projectEvents(body);
    case 'ping':
      return { ok: true };
  }
}

export function createProxy(upstream: Upstream, opts: ProxyOptions): http.Server {
  const expected = digest(assertValidToken(opts.token));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInflight = opts.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  let inflight = 0;

  const send = (
    res: http.ServerResponse,
    status: number,
    payload: unknown,
    extra: http.OutgoingHttpHeaders = {},
  ) => {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(text),
      ...(status >= 400 ? { connection: 'close' } : {}),
      ...extra,
    });
    res.end(text);
  };

  const server = http.createServer({ connectionsCheckingInterval: 1_000 }, async (req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});

    // Authentication comes first, so an unauthenticated caller learns nothing about the allowlist.
    if (!authorized(req.headers.authorization, expected)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
    }
    const d = decide(req.method, req.url);
    if (!d.ok) return send(res, d.status, { error: d.message });
    // Every permitted request is a bodiless GET; anything else is refused before it is read.
    if (
      (req.headers['content-length'] && req.headers['content-length'] !== '0') ||
      req.headers['transfer-encoding']
    ) {
      return send(res, 400, { error: 'Request bodies are not accepted' });
    }
    if (d.route.kind === 'events' && d.route.empty) return send(res, 200, []);
    if (inflight >= maxInflight) return send(res, 503, { error: 'Too many requests' });

    inflight++;
    const abort = new AbortController();
    // A client that goes away must not leave work running against Docker.
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const up = await fetchUpstream(upstream, d.upstreamPath, timeoutMs, abort.signal);
      if (up.status === 404) return send(res, 404, { error: 'Not found' });
      if (up.status !== 200) return send(res, 502, { error: `Docker returned ${up.status}` });
      return send(res, 200, project(d.route, up.body));
    } catch {
      // Upstream details (socket paths, error text) are not echoed to the caller.
      return send(res, 502, { error: 'Docker is unavailable' });
    } finally {
      inflight--;
    }
  });

  // Slow or stalled clients cannot hold connections open.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  return server;
}

/** Reads the token from PROXY_TOKEN_FILE (preferred: it stays out of `docker inspect`) or PROXY_TOKEN. */
export function readToken(env: NodeJS.ProcessEnv): string {
  const file = env.PROXY_TOKEN_FILE;
  if (file && env.PROXY_TOKEN) throw new Error('Set only one of PROXY_TOKEN and PROXY_TOKEN_FILE');
  const raw = file ? readFileSync(file, 'utf8') : env.PROXY_TOKEN;
  return assertValidToken(raw?.trim());
}

if (import.meta.main) {
  try {
    const socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
    const port = Number(process.env.PROXY_PORT ?? 2375);
    const host = process.env.PROXY_HOST ?? '0.0.0.0';
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PROXY_PORT');
    const server = createProxy({ socketPath }, { token: readToken(process.env) });
    server.listen(port, host, () => {
      process.stdout.write(`docker-proxy listening on ${host}:${port}, upstream ${socketPath}\n`);
    });
    const shutdown = () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 3_000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    // The message names the problem but can never contain the token itself.
    process.stderr.write(`docker-proxy refused to start: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
