import { describe, expect, it } from 'vitest';
import { decide } from '../src/policy.ts';

const filters = (f: unknown) => encodeURIComponent(JSON.stringify(f));
const goodFilters = filters({ type: ['container'], event: ['start', 'die', 'health_status'] });

describe('allowed routes', () => {
  it.each([
    ['/_ping', '/_ping'],
    ['/info', '/info'],
    ['/containers/json', '/containers/json?all=0'],
    ['/containers/json?all=true', '/containers/json?all=1'],
    ['/containers/json?all=0', '/containers/json?all=0'],
    ['/containers/web-1/json', '/containers/web-1/json'],
    [
      '/containers/abc123def456/stats?stream=false&one-shot=true',
      '/containers/abc123def456/stats?stream=false&one-shot=true',
    ],
  ])('permits GET %s', (url, upstream) => {
    const d = decide('GET', url);
    expect(d.ok && d.upstreamPath).toBe(upstream);
  });

  it('permits a bounded, filtered events query and rebuilds the filter canonically', () => {
    const d = decide('GET', `/events?since=100&until=200&filters=${goodFilters}`);
    expect(d.ok).toBe(true);
    if (d.ok)
      expect(decodeURIComponent(d.upstreamPath)).toContain(
        '{"type":["container"],"event":["start","die","health_status"]}',
      );
  });
});

describe('events window', () => {
  const NOW = 1_000_000;
  const q = (since: number, until: number) =>
    `/events?since=${since}&until=${until}&filters=${goodFilters}`;

  it('clamps an end time in the future so the call can never become a stream', () => {
    const d = decide('GET', q(NOW - 100, NOW + 3000), NOW);
    expect(d.ok && d.upstreamPath).toContain(`until=${NOW - 1}`);
    expect(d.ok && d.route.kind === 'events' && d.route.empty).toBe(false);
  });

  it('answers empty without contacting Docker when the whole window is in the future', () => {
    const d = decide('GET', q(NOW + 5, NOW + 50), NOW);
    expect(d.ok && d.route.kind === 'events' && d.route.empty).toBe(true);
  });

  it('leaves a window that already ended untouched', () => {
    const d = decide('GET', q(NOW - 200, NOW - 100), NOW);
    expect(d.ok && d.upstreamPath).toContain(`until=${NOW - 100}`);
  });
});

describe('denied', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', undefined])(
    'refuses method %s',
    (m) => {
      const d = decide(m, '/containers/json');
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.status).toBe(405);
    },
  );

  it.each([
    '/containers/x/logs',
    '/containers/x/exec',
    '/containers/x/archive?path=/etc/passwd',
    '/containers/x/export',
    '/containers/x/top',
    '/containers/x/changes',
    '/containers/x/attach/ws',
    '/containers/x/start',
    '/containers/x/stop',
    '/containers/x/kill',
    '/containers/create',
    '/containers/prune',
    '/exec/abc/start',
    '/images/json',
    '/volumes',
    '/networks',
    '/secrets',
    '/configs',
    '/swarm',
    '/services',
    '/system/df',
    '/auth',
    '/build',
    '/session',
    '/plugins',
    '/v1.43/containers/json',
    '//containers/json',
    '/containers/json/',
    '/',
    '',
  ])('refuses route %s', (url) => {
    expect(decide('GET', url).ok).toBe(false);
  });

  it.each([
    '/containers/json?all=true&filters={"status":["running"]}',
    '/containers/json?size=1',
    '/containers/json?all=yes',
    '/containers/json?all=1&all=0',
    '/info?x=1',
    '/containers/web/json?size=1',
  ])('refuses unexpected parameters in %s', (url) => {
    expect(decide('GET', url).ok).toBe(false);
  });

  it.each([
    '/containers/a b/json',
    '/containers/a;rm/json',
    '/containers/a$(id)/json',
    '/containers/-leading/json',
    '/containers/%2e%2e/json',
    '/containers/..%2finfo/json',
    `/containers/${'a'.repeat(200)}/json`,
  ])('refuses malformed container id in %s', (url) => {
    expect(decide('GET', url).ok).toBe(false);
  });

  it.each([
    '/containers/x/stats',
    '/containers/x/stats?stream=true&one-shot=false',
    '/containers/x/stats?stream=true',
    '/containers/x/stats?stream=false',
    '/containers/x/stats?stream=false&one-shot=true&extra=1',
  ])('only allows single-sample stats: %s', (url) => {
    expect(decide('GET', url).ok).toBe(false);
  });

  it('refuses unbounded or malformed event queries', () => {
    const bad = [
      '/events',
      `/events?since=1&until=2`,
      `/events?since=1&filters=${goodFilters}`,
      `/events?since=abc&until=2&filters=${goodFilters}`,
      `/events?since=200&until=100&filters=${goodFilters}`,
      `/events?since=0&until=99999&filters=${goodFilters}`,
      `/events?since=1&until=2&filters=${filters({ type: ['image'], event: ['start'] })}`,
      `/events?since=1&until=2&filters=${filters({ type: ['container'] })}`,
      `/events?since=1&until=2&filters=${filters({ type: ['container'], event: ['exec_create'] })}`,
      `/events?since=1&until=2&filters=${filters({ type: ['container'], event: ['start'], label: ['x'] })}`,
      `/events?since=1&until=2&filters=${filters({ type: ['container', 'volume'], event: ['start'] })}`,
      `/events?since=1&until=2&filters=not-json`,
      `/events?since=1&until=2&filters=${goodFilters}&extra=1`,
    ];
    for (const u of bad) expect(decide('GET', u).ok, u).toBe(false);
  });
});
