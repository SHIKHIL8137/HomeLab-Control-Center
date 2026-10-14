import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { decide } from '../../docker-proxy/src/policy.ts';
import { createDockerAdapter } from '../src/providers/docker.ts';
import { ProviderUnavailableError } from '../src/providers/types.ts';

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/docker/${name}`, import.meta.url), 'utf8'));
const list = fx('list.json') as { Id: string; Names: string[] }[];
const idOf = (name: string) => list.find((c) => c.Names[0]!.includes(name))!.Id;
const WEB = idOf('web');
const EXIT = idOf('exit');
const LOOP = idOf('loop');

type Handler = (path: string, res: http.ServerResponse, n: number) => boolean | void;

const TEST_TOKEN = 'test-only-docker-token-0123456789abcdef0123456789';
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.closeAllConnections();
          s.close(() => r(null));
        }),
    ),
  );
});

/** A fake docker-proxy serving the real recorded responses. */
async function proxy(override?: Handler) {
  const requests: { method: string; path: string }[] = [];
  const auths: string[] = [];
  const counts = new Map<string, number>();
  let inflight = 0;
  let maxInflight = 0;
  const s = http.createServer((req, res) => {
    const path = req.url ?? '';
    requests.push({ method: req.method ?? '', path });
    auths.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      res.writeHead(401).end('{"error":"Unauthorized"}');
      return;
    }
    const key = path.split('?')[0]!;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    res.on('close', () => inflight--);
    if (override?.(path, res, n)) return;
    const json = (v: unknown) =>
      setTimeout(
        () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v)),
        5,
      );
    if (key === '/info') return json(fx('info.json'));
    if (key === '/containers/json') return json(list);
    if (key === `/containers/${WEB}/json`) return json(fx('inspect-web.json'));
    if (key === `/containers/${EXIT}/json`) return json(fx('inspect-exit.json'));
    if (key === `/containers/${LOOP}/json`) return json(fx('inspect-loop.json'));
    if (key === `/containers/${WEB}/stats`) {
      const s0 = fx('stats-web.json');
      if (n > 1) {
        s0.cpu_stats.cpu_usage.total_usage += 1e9 * (n - 1);
        s0.cpu_stats.system_cpu_usage += 8e9 * (n - 1);
      }
      return json(s0);
    }
    if (key === '/events') return json(fx('events.json'));
    res.writeHead(404).end('{}');
  });
  servers.push(s);
  const port = await new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)),
  );
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    auths,
    maxInflight: () => maxInflight,
    port,
  };
}

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const adapter = (baseUrl: string, over: Partial<Parameters<typeof createDockerAdapter>[0]> = {}) =>
  createDockerAdapter({ baseUrl, clock: () => NOW, ...over, token: over.token ?? TEST_TOKEN });

describe('docker adapter: authentication', () => {
  it('presents the credential on every request', async () => {
    const p = await proxy();
    await adapter(p.baseUrl).read();
    expect(p.requests.length).toBeGreaterThan(5);
    expect(new Set(p.auths)).toEqual(new Set([`Bearer ${TEST_TOKEN}`]));
  });

  it('reports a rejected credential distinctly and never echoes it', async () => {
    const p = await proxy();
    const err = await adapter(p.baseUrl, { token: 'wrong-token-0123456789abcdef0123456789abcdef' })
      .read()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toMatch(/rejected the credential/);
    expect((err as Error).message).not.toContain('wrong-token');
    expect((err as Error).message).not.toContain(TEST_TOKEN);
  });

  it('never leaks the credential through warnings', async () => {
    const p = await proxy((path, res) =>
      path.includes('/stats') ? (res.writeHead(500).end(TEST_TOKEN), true) : false,
    );
    const snap = await adapter(p.baseUrl).read();
    expect(JSON.stringify(snap)).not.toContain(TEST_TOKEN);
  });
});

describe('docker adapter: inventory', () => {
  it('maps the real engine responses to container records', async () => {
    const p = await proxy();
    const snap = await adapter(p.baseUrl).read();
    expect(snap.warnings).toEqual([]);
    expect(snap.containers.map((c) => c.name).sort()).toEqual([
      'hlcc-p3-exit',
      'hlcc-p3-loop',
      'hlcc-p3-web',
    ]);

    const web = snap.containers.find((c) => c.name === 'hlcc-p3-web')!;
    expect(web).toMatchObject({
      state: 'running',
      health: 'healthy',
      restartCount: 0,
      exitCode: null,
      memLimitBytes: 134217728,
      ports: ['6379/tcp'],
      image: 'redis:7-alpine',
    });
    expect(web.memUsageBytes).toBe(3977216);
    expect(web.startedAt).toMatch(/^2026-10-14T08:24:02/);
    expect(web.createdAt).toMatch(/^20\d\d-/);

    const exit = snap.containers.find((c) => c.name === 'hlcc-p3-exit')!;
    expect(exit).toMatchObject({
      state: 'exited',
      exitCode: 3,
      health: 'none',
      cpuPercent: null,
      memUsageBytes: null,
      memLimitBytes: null,
    });

    const loop = snap.containers.find((c) => c.name === 'hlcc-p3-loop')!;
    expect(loop).toMatchObject({ state: 'exited', restartCount: 4, exitCode: 1 });
  });

  it('reads daemon facts used to cross-check /proc', async () => {
    const p = await proxy();
    const snap = await adapter(p.baseUrl).read();
    expect(snap.daemon).toMatchObject({
      memTotalBytes: 6214492160,
      ncpu: 4,
      operatingSystem: 'Docker Desktop',
    });
  });

  it('only ever sends GET requests for allowlisted paths', async () => {
    const p = await proxy();
    await adapter(p.baseUrl).read();
    expect(new Set(p.requests.map((r) => r.method))).toEqual(new Set(['GET']));
    // The contract with the real proxy: every request must pass its allowlist unchanged.
    expect(p.requests.length).toBeGreaterThan(5);
    for (const r of p.requests) {
      const d = decide('GET', r.path, Math.floor(NOW / 1000) + 10);
      expect(d.ok, r.path).toBe(true);
    }
    expect(p.requests.map((r) => r.path.split('?')[0]!.replace(/[a-f0-9]{64}/, '{id}'))).toEqual(
      expect.arrayContaining([
        '/info',
        '/containers/json',
        '/containers/{id}/json',
        '/containers/{id}/stats',
        '/events',
      ]),
    );
  });

  it('limits concurrency toward the proxy', async () => {
    const p = await proxy();
    await adapter(p.baseUrl, { concurrency: 1 }).read();
    expect(p.maxInflight()).toBe(1);
  });
});

describe('docker adapter: CPU and memory', () => {
  it('has no CPU figure on the first sample and computes one from the next', async () => {
    const p = await proxy();
    const a = adapter(p.baseUrl);
    const first = (await a.read()).containers.find((c) => c.name === 'hlcc-p3-web')!;
    expect(first.cpuPercent).toBeNull();
    const second = (await a.read()).containers.find((c) => c.name === 'hlcc-p3-web')!;
    expect(second.cpuPercent).toBe(50); // 1 s of CPU over 8 s of 4-CPU time
  });

  it('subtracts reclaimable page cache from memory usage', async () => {
    const p = await proxy((path, res) => {
      if (path.includes('/stats')) {
        const s = fx('stats-web.json');
        s.memory_stats.stats = { inactive_file: 1_000_000 };
        res.writeHead(200).end(JSON.stringify(s));
        return true;
      }
    });
    const web = (await adapter(p.baseUrl).read()).containers.find((c) => c.name === 'hlcc-p3-web')!;
    expect(web.memUsageBytes).toBe(3977216 - 1_000_000);
  });

  it('reports a memory limit of zero as "no cap", never as a limit', async () => {
    const p = await proxy();
    const loop = (await adapter(p.baseUrl).read()).containers.find(
      (c) => c.name === 'hlcc-p3-loop',
    )!;
    expect(loop.memLimitBytes).toBeNull();
  });
});

describe('docker adapter: events', () => {
  it('returns allowlisted events with millisecond timestamps and exit codes', async () => {
    const p = await proxy();
    const { events } = await adapter(p.baseUrl).read();
    expect(events.length).toBeGreaterThan(5);
    expect(new Set(events.map((e) => e.action))).toEqual(
      new Set(['start', 'die', 'health_status']),
    );
    const die = events.find((e) => e.action === 'die' && e.container === 'hlcc-p3-exit')!;
    expect(die.exitCode).toBe(3);
    expect(die.ts).toBeGreaterThan(1_790_000_000_000); // milliseconds
  });

  it('continues each window where the last one ended and never asks for the future', async () => {
    const p = await proxy();
    let now = NOW;
    const a = createDockerAdapter({ token: TEST_TOKEN, baseUrl: p.baseUrl, clock: () => now });
    await a.read();
    now += 15_000;
    await a.read();
    const windows = p.requests
      .filter((r) => r.path.startsWith('/events'))
      .map((r) => {
        const q = new URL(r.path, 'http://x').searchParams;
        return { since: Number(q.get('since')), until: Number(q.get('until')) };
      });
    expect(windows).toHaveLength(2);
    expect(windows[0]!.until).toBe(Math.floor(NOW / 1000) - 2);
    expect(windows[1]!.since).toBe(windows[0]!.until + 1);
    expect(windows[1]!.until).toBeLessThan(Math.floor((NOW + 15_000) / 1000));
  });

  it('caps a catch-up window after a long gap', async () => {
    const p = await proxy();
    let now = NOW;
    const a = createDockerAdapter({ token: TEST_TOKEN, baseUrl: p.baseUrl, clock: () => now });
    await a.read();
    now += 6 * 3600_000;
    await a.read();
    const last = p.requests.filter((r) => r.path.startsWith('/events')).at(-1)!;
    const q = new URL(last.path, 'http://x').searchParams;
    expect(Number(q.get('until')) - Number(q.get('since'))).toBeLessThanOrEqual(3500);
  });

  it('keeps the inventory when events fail, and reports the problem', async () => {
    const p = await proxy((path, res) =>
      path.startsWith('/events') ? (res.writeHead(502).end('{}'), true) : false,
    );
    const snap = await adapter(p.baseUrl).read();
    expect(snap.containers).toHaveLength(3);
    expect(snap.events).toEqual([]);
    expect(snap.warnings.join(' ')).toMatch(/events unavailable/);
  });

  it('retries the same window after a failure instead of skipping it', async () => {
    const p = await proxy((path, res, n) =>
      path.startsWith('/events') && n === 1 ? (res.writeHead(502).end('{}'), true) : false,
    );
    const a = adapter(p.baseUrl);
    await a.read();
    await a.read();
    const [first, second] = p.requests
      .filter((r) => r.path.startsWith('/events'))
      .map((r) => new URL(r.path, 'http://x').searchParams.get('since'));
    expect(second).toBe(first);
  });
});

describe('docker adapter: partial failures', () => {
  it('marks a container whose inspect failed as unknown rather than guessing', async () => {
    const p = await proxy((path, res) =>
      path === `/containers/${WEB}/json` ? (res.writeHead(500).end('boom'), true) : false,
    );
    const snap = await adapter(p.baseUrl).read();
    const web = snap.containers.find((c) => c.name === 'hlcc-p3-web')!;
    expect(web).toMatchObject({ state: 'running', health: 'unknown', restartCount: null });
    expect(snap.containers).toHaveLength(3);
    expect(snap.warnings.join(' ')).toMatch(/hlcc-p3-web: inspect failed/);
  });

  it('drops a container that vanished between list and inspect', async () => {
    const p = await proxy((path, res) =>
      path === `/containers/${EXIT}/json` ? (res.writeHead(404).end('{}'), true) : false,
    );
    const snap = await adapter(p.baseUrl).read();
    expect(snap.containers.map((c) => c.name)).not.toContain('hlcc-p3-exit');
    expect(snap.warnings).toEqual([]);
  });

  it('leaves CPU and memory empty when stats fail, and says so', async () => {
    const p = await proxy((path, res) =>
      path.includes('/stats') ? (res.writeHead(500).end('x'), true) : false,
    );
    const web = (await adapter(p.baseUrl).read()).containers.find((c) => c.name === 'hlcc-p3-web')!;
    expect(web).toMatchObject({
      cpuPercent: null,
      memUsageBytes: null,
      state: 'running',
      health: 'healthy',
    });
  });

  it('skips containers with an implausible id instead of building a path from it', async () => {
    const evil = [{ ...list[0]!, Id: '../../etc/passwd' }];
    const p = await proxy((path, res) =>
      path.startsWith('/containers/json')
        ? (res.writeHead(200).end(JSON.stringify(evil)), true)
        : false,
    );
    const snap = await adapter(p.baseUrl).read();
    expect(snap.containers).toEqual([]);
    expect(snap.warnings.join(' ')).toMatch(/unexpected container id/);
    expect(p.requests.some((r) => r.path.includes('passwd'))).toBe(false);
  });
});

describe('docker adapter: the proxy is unavailable or misbehaves', () => {
  const rejects = async (a: ReturnType<typeof adapter>, re: RegExp) => {
    const err = await a.read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toMatch(re);
  };

  it('reports a refused connection', async () => {
    const p = await proxy();
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    await rejects(adapter(p.baseUrl), /Docker unavailable/);
  });

  it('reports an error status from the proxy', async () => {
    const p = await proxy((path, res) =>
      path === '/info'
        ? (res.writeHead(502).end('{"error":"Docker is unavailable"}'), true)
        : false,
    );
    await rejects(adapter(p.baseUrl), /502/);
  });

  it('rejects malformed JSON and wrong shapes', async () => {
    const bad = await proxy((path, res) =>
      path.startsWith('/containers/json') ? (res.writeHead(200).end('{not json'), true) : false,
    );
    await rejects(adapter(bad.baseUrl), /malformed/);
    const wrong = await proxy((path, res) =>
      path.startsWith('/containers/json')
        ? (res.writeHead(200).end('{"containers":[]}'), true)
        : false,
    );
    await rejects(adapter(wrong.baseUrl), /malformed/);
    const state = await proxy((path, res) =>
      path.startsWith('/containers/json')
        ? (res.writeHead(200).end(JSON.stringify([{ ...list[0], State: 'exploded' }])), true)
        : false,
    );
    await rejects(adapter(state.baseUrl), /malformed/);
  });

  it('times out a proxy that never answers', async () => {
    const p = await proxy((path) => path === '/info');
    await rejects(adapter(p.baseUrl, { timeoutMs: 150 }), /timed out/);
  });

  it('refuses an oversized response', async () => {
    const p = await proxy((path, res) =>
      path === '/info' ? (res.writeHead(200).end('x'.repeat(9 * 1024 * 1024)), true) : false,
    );
    await rejects(adapter(p.baseUrl), /too large/);
  });

  it('only accepts a plain-http proxy URL', () => {
    expect(() =>
      createDockerAdapter({
        token: TEST_TOKEN,
        baseUrl: 'https://docker-proxy:2375',
        clock: () => NOW,
      }),
    ).toThrow(/http/);
  });
});

describe('docker adapter: daemonInfo', () => {
  it('caches briefly and maps failure to unavailable', async () => {
    const p = await proxy();
    let now = NOW;
    const a = createDockerAdapter({ token: TEST_TOKEN, baseUrl: p.baseUrl, clock: () => now });
    await a.daemonInfo();
    await a.daemonInfo();
    expect(p.requests.filter((r) => r.path === '/info')).toHaveLength(1);
    now += 31_000;
    await a.daemonInfo();
    expect(p.requests.filter((r) => r.path === '/info')).toHaveLength(2);

    const down = await proxy();
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    await expect(adapter(down.baseUrl).daemonInfo()).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});
