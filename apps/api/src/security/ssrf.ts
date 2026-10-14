import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound HTTP for health checks and Netdata, hardened against SSRF:
 *  - the destination IP is validated when the connection is made (DNS rebinding cannot swap it
 *    afterwards, because the socket connects to the very address that was validated);
 *  - every redirect hop is validated again, and a redirect can never move to another private host;
 *  - link-local, metadata, multicast, reserved and unspecified ranges are blocked even when a
 *    project is authorised for private targets.
 */

export type IpClass = 'blocked' | 'private' | 'public';

const alwaysBlocked = new net.BlockList();
const privateRanges = new net.BlockList();
const loopback6 = new net.BlockList();

for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  alwaysBlocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 96],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['100::', 64],
  ['2002::', 16],
  ['2001::', 32],
] as const)
  alwaysBlocked.addSubnet(net6, prefix, 'ipv6');
alwaysBlocked.addAddress('fd00:ec2::254', 'ipv6'); // AWS IPv6 metadata, inside the ULA range

for (const [net4, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['100.64.0.0', 10],
] as const) {
  privateRanges.addSubnet(net4, prefix, 'ipv4'); // 100.64/10 covers Tailscale
}
privateRanges.addSubnet('fc00::', 7, 'ipv6');
loopback6.addAddress('::1', 'ipv6');

function unmapV4(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) return dotted[1] as string;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** Anything that is not a valid IP literal is treated as blocked. */
export function classifyIp(input: string): IpClass {
  let ip = input
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  let family = net.isIP(ip);
  if (family === 0) return 'blocked';
  if (family === 6) {
    const v4 = unmapV4(ip);
    if (v4) {
      ip = v4;
      family = 4;
    }
  }
  if (family === 4) {
    if (alwaysBlocked.check(ip, 'ipv4')) return 'blocked';
    return privateRanges.check(ip, 'ipv4') ? 'private' : 'public';
  }
  if (loopback6.check(ip, 'ipv6')) return 'private';
  if (alwaysBlocked.check(ip, 'ipv6')) return 'blocked';
  return privateRanges.check(ip, 'ipv6') ? 'private' : 'public';
}

/**
 * Ports that speak other protocols (shells, mail, databases, caches, the Docker API) and have no
 * business answering an HTTP health check. They are refused for every target, public or private.
 */
const BLOCKED_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 111, 119, 135, 137, 138, 139, 143, 161, 389, 445, 465, 514, 587, 636,
  873, 993, 995, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

/** The port a URL really connects to, including the scheme default. */
export function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

export const isBlockedPort = (port: number) => BLOCKED_PORTS.has(port);

export type TargetValidation =
  { ok: true } | { ok: false; code: 'invalid_url' | 'blocked'; message: string };

/**
 * Static, synchronous checks for a URL supplied through the UI. This gives early feedback only;
 * the real enforcement happens at connection time inside guardedGet().
 */
export function validateTarget(raw: string, allowPrivate: boolean): TargetValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url', message: 'Not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, code: 'invalid_url', message: 'Only http and https are allowed' };
  if (url.username || url.password)
    return { ok: false, code: 'invalid_url', message: 'Credentials in URLs are not allowed' };
  if (isBlockedPort(effectivePort(url))) {
    return { ok: false, code: 'blocked', message: 'That port is never allowed for a health check' };
  }
  // A trailing dot names the same host ("localhost."), so it must not be a way around the check.
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (net.isIP(host)) {
    const c = classifyIp(host);
    if (c === 'blocked')
      return {
        ok: false,
        code: 'blocked',
        message: 'That address range is never allowed (link-local, metadata, reserved)',
      };
    if (c === 'private' && !allowPrivate)
      return {
        ok: false,
        code: 'blocked',
        message: 'Private addresses need explicit authorization for this project',
      };
  } else if ((host === 'localhost' || host.endsWith('.localhost')) && !allowPrivate) {
    return {
      ok: false,
      code: 'blocked',
      message: 'Loopback targets need explicit authorization for this project',
    };
  }
  return { ok: true };
}

export type GuardedFailure =
  'blocked' | 'timeout' | 'dns' | 'connect' | 'redirect' | 'too_large' | 'invalid_url';

export interface GuardedOptions {
  allowPrivate: boolean;
  timeoutMs?: number;
  overallMs?: number;
  maxRedirects?: number;
  /** When set, the response body is returned (up to maxBytes); otherwise it is discarded unread. */
  readBody?: { maxBytes: number };
  /** Replaceable for tests. */
  resolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export interface GuardedResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  targetClass: 'public' | 'private' | null;
  failure: GuardedFailure | null;
  message: string | null;
  body?: string;
}

class Violation extends Error {}
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const defaultResolver = (hostname: string) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

const originOf = (u: URL) =>
  `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;

function once(
  url: URL,
  allowPrivate: boolean,
  o: GuardedOptions,
  signal: AbortSignal,
): Promise<{ status: number; location: string | null; cls: 'public' | 'private'; body?: string }> {
  return new Promise((resolve, reject) => {
    if (isBlockedPort(effectivePort(url))) {
      return reject(new Violation('destination port is not permitted'));
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const literal = net.isIP(host) ? classifyIp(host) : null;
    if (literal === 'blocked' || (literal === 'private' && !allowPrivate)) {
      return reject(new Violation('destination address is not permitted'));
    }
    const resolver = o.resolver ?? defaultResolver;
    const lookup = (
      hostname: string,
      options: dns.LookupOptions,
      cb: (...args: unknown[]) => void,
    ) => {
      resolver(hostname).then(
        (addrs) => {
          if (!addrs.length)
            return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
          // One bad address poisons the whole answer, so a mixed reply cannot slip through.
          for (const a of addrs) {
            const c = classifyIp(a.address);
            if (c === 'blocked' || (c === 'private' && !allowPrivate))
              return cb(new Violation('destination address is not permitted'));
          }
          if (options.all) return cb(null, addrs);
          return cb(null, addrs[0]!.address, addrs[0]!.family);
        },
        (err: unknown) => cb(err),
      );
    };

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        timeout: o.timeoutMs ?? 5000,
        signal,
        lookup: lookup as unknown as net.LookupFunction,
        headers: {
          'user-agent': 'HomeLabControlCenter/0.1 (health-check)',
          accept: '*/*',
          connection: 'close',
        },
      },
      (res) => {
        const cls = classifyIp(res.socket.remoteAddress ?? '');
        if (cls === 'blocked' || (cls === 'private' && !allowPrivate)) {
          res.destroy();
          return reject(new Violation('connected address is not permitted'));
        }
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if (!o.readBody) {
          res.destroy();
          return resolve({ status, location, cls: cls === 'private' ? 'private' : 'public' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > o.readBody!.maxBytes) {
            tooLarge = true;
            reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
            req.destroy();
            return;
          }
          chunks.push(d);
        });
        res.on(
          'end',
          () =>
            tooLarge ||
            resolve({
              status,
              location,
              cls: cls === 'private' ? 'private' : 'public',
              body: Buffer.concat(chunks).toString('utf8'),
            }),
        );
        res.on('error', reject);
      },
    );
    // Belt and braces: re-check the address the socket really connected to.
    req.on('socket', (socket) => {
      const check = () => {
        const cls = classifyIp(socket.remoteAddress ?? '');
        if (cls === 'blocked' || (cls === 'private' && !allowPrivate))
          req.destroy(new Violation('connected address is not permitted'));
      };
      if (socket.connecting) socket.once('connect', check);
      else check();
    });
    req.on('timeout', () =>
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT_GUARD' })),
    );
    req.on('error', reject);
    req.end();
  });
}

export async function guardedGet(rawUrl: string, o: GuardedOptions): Promise<GuardedResult> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  const bad = (
    failure: GuardedFailure,
    message: string,
    statusCode: number | null = null,
    targetClass: GuardedResult['targetClass'] = null,
  ): GuardedResult => ({
    ok: false,
    statusCode,
    latencyMs: latency(),
    targetClass,
    failure,
    message,
  });

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return bad('invalid_url', 'Not a valid URL');
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:')
    return bad('invalid_url', 'Only http and https are allowed');
  if (current.username || current.password)
    return bad('invalid_url', 'Credentials in URLs are not allowed');

  const original = current;
  const maxRedirects = o.maxRedirects ?? 3;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), o.overallMs ?? 10_000);
  try {
    for (let hop = 0; ; hop++) {
      // A redirect may only reach the authorised private host itself, never another private one.
      const allow = o.allowPrivate && originOf(current) === originOf(original);
      let r;
      try {
        r = await once(current, allow, o, controller.signal);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (err instanceof Violation) return bad('blocked', 'Destination address is not permitted');
        if (e.code === 'TOO_LARGE') return bad('too_large', 'Response too large');
        if (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'ETIMEDOUT_GUARD')
          return bad('timeout', 'Timed out');
        if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN')
          return bad('dns', 'Name could not be resolved');
        return bad('connect', `Connection failed${e.code ? ` (${e.code})` : ''}`);
      }
      if (REDIRECTS.has(r.status) && r.location) {
        if (hop >= maxRedirects) return bad('redirect', 'Too many redirects', r.status, r.cls);
        let next: URL;
        try {
          next = new URL(r.location, current);
        } catch {
          return bad('redirect', 'Invalid redirect target', r.status, r.cls);
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:')
          return bad('redirect', 'Redirect to an unsupported scheme', r.status, r.cls);
        if (current.protocol === 'https:' && next.protocol === 'http:')
          return bad('redirect', 'Redirect downgrades to plain http', r.status, r.cls);
        if (next.username || next.password)
          return bad('redirect', 'Redirect target contains credentials', r.status, r.cls);
        current = next;
        continue;
      }
      return {
        ok: r.status >= 200 && r.status < 300,
        statusCode: r.status,
        latencyMs: latency(),
        targetClass: r.cls,
        failure: null,
        message: null,
        ...(r.body !== undefined ? { body: r.body } : {}),
      };
    }
  } finally {
    clearTimeout(deadline);
  }
}
