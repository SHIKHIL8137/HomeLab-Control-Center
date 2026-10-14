/**
 * The complete list of Docker Engine API calls the dashboard needs, verified against a real engine:
 *
 *   GET /_ping
 *   GET /info
 *   GET /containers/json?all=<bool>
 *   GET /containers/{id}/json
 *   GET /containers/{id}/stats?stream=false&one-shot=true
 *   GET /events?since=<s>&until=<s>&filters={"type":["container"],"event":[...allowed...]}
 *
 * Everything else is refused: all non-GET methods, logs, exec, archive/export (file reads),
 * attach, top, changes, images, volumes, networks, secrets, swarm and the rest. Upstream paths are
 * rebuilt from validated parts; the raw request URL is never forwarded.
 */

export const ALLOWED_EVENTS = [
  'start',
  'stop',
  'die',
  'kill',
  'oom',
  'restart',
  'health_status',
] as const;
export const MAX_EVENT_WINDOW_SECONDS = 3600;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const INT = /^\d{1,12}$/;

export type Route =
  | { kind: 'ping' }
  | { kind: 'info' }
  | { kind: 'list' }
  | { kind: 'inspect'; id: string }
  | { kind: 'stats'; id: string }
  | { kind: 'events'; empty: boolean };

export type Decision =
  { ok: true; route: Route; upstreamPath: string } | { ok: false; status: number; message: string };

const deny = (status: number, message: string): Decision => ({ ok: false, status, message });

/** Only these query parameters, exactly once each, are accepted for a route. */
function params(url: URL, allowed: string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k) || out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}

function canonicalFilters(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  if (Object.keys(f).some((k) => k !== 'type' && k !== 'event')) return null;
  const type = f.type;
  if (!Array.isArray(type) || type.length !== 1 || type[0] !== 'container') return null;
  const event = f.event;
  if (!Array.isArray(event) || event.length === 0) return null;
  if (!event.every((e) => (ALLOWED_EVENTS as readonly string[]).includes(String(e)))) return null;
  return JSON.stringify({ type: ['container'], event: [...new Set(event.map(String))] });
}

// Only these characters may appear in a request target. Notably absent from the path: "%", "\", "#",
// spaces and control characters; the query may carry percent-encoding (the events filter is JSON).
const RAW_TARGET = /^\/[A-Za-z0-9_\-./]*(\?[A-Za-z0-9_\-.~=&%,:]*)?$/;

/**
 * The URL parser would happily normalise "//host/x", "/a/../b", "/a/%2e%2e/b" or "\" into an allowed
 * route. We refuse anything that is not already in canonical form instead of trusting the
 * normalisation, so there is exactly one spelling of each permitted request.
 */
export function isCanonicalTarget(raw: string): boolean {
  if (!RAW_TARGET.test(raw)) return false;
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (path !== '/') {
    const ok = path
      .slice(1)
      .split('/')
      .every((s) => s !== '' && s !== '.' && s !== '..');
    if (!ok) return false;
  }
  if (q < 0) return true;
  // Query parameters are compared as written: names are plain, and a value may be percent-encoded
  // only for "filters" (a JSON document). Otherwise "?%61ll=true" would decode into "all=true".
  for (const pair of raw.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    if (!/^[a-z][a-z-]*$/.test(name)) return false;
    if (name === 'filters' ? !/^[A-Za-z0-9_\-.~%]*$/.test(value) : !/^[A-Za-z0-9_.-]*$/.test(value))
      return false;
  }
  return true;
}

export function decide(
  method: string | undefined,
  rawUrl: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Decision {
  if (method !== 'GET') return deny(405, 'Only GET is permitted');
  if (!rawUrl || rawUrl.length > 2048) return deny(400, 'Bad request');
  if (!isCanonicalTarget(rawUrl)) return deny(400, 'Bad request');

  let url: URL;
  try {
    url = new URL(rawUrl, 'http://proxy.invalid');
  } catch {
    return deny(400, 'Bad request');
  }
  const path = url.pathname;

  if (path === '/_ping') {
    return params(url, [])
      ? { ok: true, route: { kind: 'ping' }, upstreamPath: '/_ping' }
      : deny(403, 'Not permitted');
  }
  if (path === '/info') {
    return params(url, [])
      ? { ok: true, route: { kind: 'info' }, upstreamPath: '/info' }
      : deny(403, 'Not permitted');
  }
  if (path === '/containers/json') {
    const p = params(url, ['all']);
    const all = p?.get('all');
    if (!p || (all !== undefined && !['true', 'false', '1', '0'].includes(all)))
      return deny(403, 'Not permitted');
    const flag = all === 'true' || all === '1' ? '1' : '0';
    return { ok: true, route: { kind: 'list' }, upstreamPath: `/containers/json?all=${flag}` };
  }

  const container = /^\/containers\/([^/]+)\/(json|stats)$/.exec(path);
  if (container) {
    const [, id, leaf] = container as unknown as [string, string, string];
    if (!ID.test(id)) return deny(403, 'Not permitted');
    if (leaf === 'json') {
      return params(url, [])
        ? { ok: true, route: { kind: 'inspect', id }, upstreamPath: `/containers/${id}/json` }
        : deny(403, 'Not permitted');
    }
    const p = params(url, ['stream', 'one-shot']);
    if (!p || p.get('stream') !== 'false' || p.get('one-shot') !== 'true')
      return deny(403, 'Stats must be a single sample');
    return {
      ok: true,
      route: { kind: 'stats', id },
      upstreamPath: `/containers/${id}/stats?stream=false&one-shot=true`,
    };
  }

  if (path === '/events') {
    const p = params(url, ['since', 'until', 'filters']);
    const since = p?.get('since');
    const until = p?.get('until');
    const filters = p?.get('filters');
    if (!p || !since || !until || !filters || !INT.test(since) || !INT.test(until))
      return deny(403, 'Not permitted');
    const window = Number(until) - Number(since);
    if (window < 0 || window > MAX_EVENT_WINDOW_SECONDS)
      return deny(403, 'Event window out of range');
    const canon = canonicalFilters(filters);
    if (!canon) return deny(403, 'Event filters not permitted');
    // Docker keeps the connection open until `until`, so a future value would become a stream.
    // Clamp to the past so every events call is a finite, bounded read.
    const end = Math.min(Number(until), nowSeconds - 1);
    return {
      ok: true,
      route: { kind: 'events', empty: Number(since) > end },
      upstreamPath: `/events?since=${since}&until=${end}&filters=${encodeURIComponent(canon)}`,
    };
  }

  return deny(403, 'Not permitted');
}
