import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/server.ts';

/** A throwaway credential for tests only; real deployments generate their own. */
export const TOKEN = 'test-only-proxy-token-0123456789abcdef0123456789';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fx(name));

const SECRET = 'supersecret-not-real-9f3a';
const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

/** A fake Docker daemon that records every path it is asked for. */
async function setup(
  handler?: (path: string, res: http.ServerResponse) => boolean,
  opts?: { timeoutMs?: number },
) {
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    const path = req.url ?? '';
    seen.push(path);
    if (handler?.(path, res)) return;
    const send = (body: string) => res.writeHead(200).end(body);
    if (path.startsWith('/containers/json')) return send(fx('list.raw.json'));
    if (/^\/containers\/[^/]+\/json$/.test(path)) {
      const raw = json('inspect-web.raw.json');
      raw.Config.Env = [`API_TOKEN=${SECRET}`, 'PATH=/usr/bin'];
      raw.Config.Cmd = ['run', `--password=${SECRET}`];
      raw.State.Health.Log = [{ Output: `connecting with ${SECRET}` }];
      return send(JSON.stringify(raw));
    }
    if (path.includes('/stats')) return send(fx('stats-web.raw.json'));
    if (path === '/info')
      return send(
        JSON.stringify({
          ...json('info.raw.json'),
          SecurityOptions: ['x'],
          RegistryConfig: { token: SECRET },
        }),
      );
    if (path.startsWith('/events')) {
      const exec = JSON.stringify({
        Type: 'container',
        Action: `exec_create: sh -c 'mysql -p${SECRET}'`,
        Actor: { Attributes: { name: 'web' } },
        time: 1,
      });
      return send(`${exec}\n${fx('events.raw.ndjson')}`);
    }
    res.writeHead(404).end('{}');
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await listen(
    createProxy({ host: '127.0.0.1', port: upstreamPort }, { token: TOKEN, ...opts }),
  );
  const call = (path: string, method = 'GET') =>
    fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  return { seen, call, upstreamPort };
}

describe('proxy', () => {
  it('returns allowlisted fields only, never environment, commands or health logs', async () => {
    const { call } = await setup();
    const inspect = await (await call('/containers/web/json')).text();
    expect(inspect).not.toContain(SECRET);
    expect(inspect).not.toMatch(/"Env"|"Cmd"|"Log"|"Entrypoint"/);
    const body = JSON.parse(inspect);
    expect(body.State.Health.Status).toBe('healthy');
    expect(body.HostConfig.Memory).toBe(134217728);
    expect(body.RestartCount).toBe(0);

    const list = await (await call('/containers/json?all=true')).text();
    expect(list).not.toMatch(/"Command"|"NetworkSettings"|"Mounts"|"HostConfig"/);
    expect(JSON.parse(list).length).toBeGreaterThan(0);

    const info = await (await call('/info')).text();
    expect(info).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(info)).sort()).toEqual([
      'KernelVersion',
      'MemTotal',
      'NCPU',
      'OperatingSystem',
      'ServerVersion',
    ]);
  });

  it('keeps only memory and cpu counters from stats', async () => {
    const { call } = await setup();
    const stats = (await (
      await call('/containers/web/stats?stream=false&one-shot=true')
    ).json()) as {
      cpu_stats: { cpu_usage: { total_usage: number } };
      memory_stats: { limit: number };
    };
    expect(Object.keys(stats).sort()).toEqual(['cpu_stats', 'memory_stats', 'read']);
    expect(stats.cpu_stats.cpu_usage.total_usage).toBeGreaterThan(0);
    expect(stats.memory_stats.limit).toBeGreaterThan(0);
  });

  it('drops exec events and anything outside the action allowlist', async () => {
    const { call } = await setup();
    const q = encodeURIComponent(
      JSON.stringify({ type: ['container'], event: ['start', 'die', 'health_status'] }),
    );
    const text = await (await call(`/events?since=1&until=100&filters=${q}`)).text();
    expect(text).not.toContain(SECRET);
    const actions = (JSON.parse(text) as { Action: string }[]).map((e) => e.Action);
    expect(actions).toContain('start');
    expect(actions).toContain('health_status');
    expect(actions.some((a) => a.startsWith('exec'))).toBe(false);
  });

  it('refuses mutations and unlisted routes without ever contacting Docker', async () => {
    const { call, seen } = await setup();
    expect((await call('/containers/web/start', 'POST')).status).toBe(405);
    expect((await call('/containers/web', 'DELETE')).status).toBe(405);
    expect((await call('/containers/web/logs')).status).toBe(403);
    expect([400, 403]).toContain((await call('/containers/web/archive?path=/')).status);
    expect((await call('/images/json')).status).toBe(403);
    expect((await call('/volumes')).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('forwards only rebuilt, validated paths', async () => {
    const { call, seen } = await setup();
    await call('/containers/json?all=true');
    await call('/containers/web/stats?stream=false&one-shot=true');
    expect(seen).toEqual([
      '/containers/json?all=1',
      '/containers/web/stats?stream=false&one-shot=true',
    ]);
  });

  it('answers 502 with a generic message when Docker is down, and leaks no address', async () => {
    const dead = http.createServer();
    const port = await listen(dead);
    await new Promise((r) => dead.close(() => r(null)));
    const proxyPort = await listen(createProxy({ host: '127.0.0.1', port }, { token: TOKEN }));
    const res = await fetch(`http://127.0.0.1:${proxyPort}/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe('{"error":"Docker is unavailable"}');
    expect(text).not.toContain('127.0.0.1');
  });

  it('maps upstream errors, malformed JSON and timeouts to 502', async () => {
    const { call: errored } = await setup((p, res) =>
      p === '/info' ? (res.writeHead(500).end('boom'), true) : false,
    );
    expect((await errored('/info')).status).toBe(502);

    const { call: malformed } = await setup((p, res) =>
      p === '/info' ? (res.writeHead(200).end('{not json'), true) : false,
    );
    expect((await malformed('/info')).status).toBe(502);

    const { call: hung } = await setup((p) => p === '/info', { timeoutMs: 150 });
    expect((await hung('/info')).status).toBe(502);
  });

  it('passes a missing container through as 404', async () => {
    const { call } = await setup((p, res) =>
      p.startsWith('/containers/gone')
        ? (res.writeHead(404).end('{"message":"No such container"}'), true)
        : false,
    );
    expect((await call('/containers/gone/json')).status).toBe(404);
  });
});
