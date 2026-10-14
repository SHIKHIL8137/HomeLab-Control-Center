import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerEvent, DockerSnapshot, HostSample, NetdataExtras } from '@hlcc/shared';
import { createMockProvider } from '../src/providers/mock.ts';
import type { Provider } from '../src/providers/types.ts';
import { insertCheck, checkStatus } from '../src/repositories/health.ts';
import { getProject } from '../src/repositories/projects.ts';
import { liveFetcher, mockFetcher, type Fetcher } from '../src/services/healthChecker.ts';
import { makeApp, signedIn } from './helpers.ts';

type Rec = Awaited<ReturnType<Fetcher>>;
// Realistic timestamps: events older than the retention window are (correctly) pruned.
const RECENT = Date.UTC(2026, 9, 14, 12) - 60_000;

const ok: Rec = { state: 'ok', statusCode: 200, latencyMs: 42, error: null, targetClass: 'public' };
const failed: Rec = {
  state: 'failed',
  statusCode: 503,
  latencyMs: 30,
  error: 'HTTP 503',
  targetClass: 'public',
};

/** A fetcher whose answer the test controls, and which records what it was asked. */
function stubFetcher(initial: Rec | 'hang' = ok) {
  const calls: { url: string; allowPrivate: boolean }[] = [];
  const state = { next: initial as Rec | 'hang' };
  const fetcher: Fetcher = (req) => {
    calls.push(req);
    return state.next === 'hang' ? new Promise<Rec>(() => {}) : Promise.resolve(state.next);
  };
  return { fetcher, calls, state };
}

const patch = (
  a: ReturnType<typeof signedIn> extends Promise<infer T> ? T : never,
  id: string,
  body: object,
) => a.agent.patch(`/api/v1/projects/${id}`).set('x-csrf-token', a.csrf).send(body);

/** Moves the clock forward and lets the collector run again, as it would in real time. */
const advance = async (h: ReturnType<typeof makeApp>, ms: number) => {
  h.time.t += ms;
  await h.collector.collectOnce();
};

const projectOf = async (a: Awaited<ReturnType<typeof signedIn>>, id = 'devworkspace') =>
  (await a.agent.get(`/api/v1/projects/${id}`)).body;

describe('HTTP health checks: not configured', () => {
  it('shows "not configured", never healthy, and makes no network request', async () => {
    const s = stubFetcher();
    const h = makeApp({ fetcher: s.fetcher });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    await h.checker.runAll();

    const p = await projectOf(a);
    expect(p.httpCheck).toMatchObject({
      state: 'not_configured',
      freshness: 'unavailable',
      statusCode: null,
      lastSuccessAt: null,
    });
    const ov = (await a.agent.get('/api/v1/overview')).body;
    expect(ov.projects.every((x: { httpCheck: string }) => x.httpCheck === 'not_configured')).toBe(
      true,
    );
    expect(ov.connectivity.find((c: { id: string }) => c.id === 'public')).toMatchObject({
      state: 'not_configured',
    });
    expect(s.calls).toEqual([]);
  });

  it('seed data ships with no health URLs configured', async () => {
    const h = makeApp();
    expect(getProject(h.db, 'devworkspace')!.healthUrl).toBeNull();
    expect(getProject(h.db, 'nextcloud')!.healthUrl).toBeNull();
    expect(getProject(h.db, 'devconnect')!.healthUrl).toBeNull();
  });
});

describe('HTTP health checks: results and project health', () => {
  const setup = async (initial: Rec | 'hang' = ok) => {
    const s = stubFetcher(initial);
    const h = makeApp({ fetcher: s.fetcher });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    const res = await patch(a, 'devworkspace', { healthUrl: 'https://example.com/healthz' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(s.calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    return { s, h, a };
  };

  it('records a successful check with latency and network class', async () => {
    const { a, s } = await setup();
    const p = await projectOf(a);
    expect(p.httpCheck).toMatchObject({
      state: 'ok',
      statusCode: 200,
      latencyMs: 42,
      targetClass: 'public',
      consecutiveFailures: 0,
      freshness: 'current',
      source: 'mock',
    });
    expect(p.httpCheck.lastSuccessAt).toBeTruthy();
    expect(p.httpCheck.lastFailureAt).toBeNull();
    expect(s.calls[0]).toEqual({ url: 'https://example.com/healthz', allowPrivate: false });
    expect(p.health.status).toBe('healthy');
  });

  it('degrades a running project after consecutive failures, not after a single one', async () => {
    const { a, h, s } = await setup();
    s.state.next = failed;
    await h.checker.runAll();
    let p = await projectOf(a);
    expect(p.httpCheck).toMatchObject({ state: 'failed', consecutiveFailures: 1 });
    expect(p.health.status).toBe('healthy');

    await advance(h, 20_000);
    await h.checker.runAll();
    p = await projectOf(a);
    expect(p.httpCheck.consecutiveFailures).toBe(2);
    expect(p.health).toMatchObject({ status: 'degraded' });
    expect(p.health.reason).toMatch(/HTTP check failed/);
    expect(p.httpCheck.lastSuccessAt).toBeTruthy();
    expect(p.httpCheck.lastFailureAt).toBeTruthy();

    s.state.next = ok;
    await advance(h, 20_000);
    await h.checker.runAll();
    p = await projectOf(a);
    expect(p.httpCheck.consecutiveFailures).toBe(0);
    expect(p.health.status).toBe('healthy');
  });

  it('degrades immediately when the target is blocked by policy', async () => {
    const { a, h, s } = await setup();
    s.state.next = {
      state: 'blocked',
      statusCode: null,
      latencyMs: null,
      error: 'Destination address is not permitted',
      targetClass: null,
    };
    await advance(h, 20_000);
    await h.checker.runAll();
    const p = await projectOf(a);
    expect(p.httpCheck.state).toBe('blocked');
    expect(p.health.status).toBe('degraded');
    expect(p.httpCheck.error).toMatch(/not permitted/);
  });

  it('never lets a successful check upgrade a project whose containers are down', async () => {
    const { a, h } = await setup();
    const res = await patch(a, 'devconnect', {
      healthUrl: 'https://example.org/up',
      desiredState: 'running',
    });
    expect(res.status).toBe(200);
    await h.checker.runAll();
    const p = await projectOf(a, 'devconnect');
    expect(p.httpCheck.state).toBe('ok');
    expect(p.health.status).toBe('down');
  });

  it("forgets results when the URL changes, instead of showing the old URL's state", async () => {
    const { a, s } = await setup();
    expect((await projectOf(a)).httpCheck.state).toBe('ok');
    s.state.next = 'hang'; // the new URL's first check does not complete
    await patch(a, 'devworkspace', { healthUrl: 'https://example.net/other' });
    const p = await projectOf(a);
    expect(p.httpCheck).toMatchObject({
      state: 'pending',
      lastSuccessAt: null,
      freshness: 'unavailable',
    });
  });

  it('stops counting an old result once it is stale', async () => {
    const { a, h, s } = await setup();
    s.state.next = failed;
    await advance(h, 20_000);
    await h.checker.runAll();
    await advance(h, 20_000);
    await h.checker.runAll();
    expect((await projectOf(a)).health.status).toBe('degraded');

    // The check results are now older than 2.5 intervals; container data is refreshed as usual.
    await advance(h, 60_000 * 2.5 + 1000);
    const p = await projectOf(a);
    expect(p.httpCheck.freshness).toBe('stale');
    expect(p.health.status).toBe('healthy'); // a stale failure is not evidence
  });

  it('removing the URL returns to "not configured"', async () => {
    const { a } = await setup();
    await patch(a, 'devworkspace', { healthUrl: null });
    expect((await projectOf(a)).httpCheck.state).toBe('not_configured');
  });

  it('keeps mock and live results apart', async () => {
    const h = makeApp();
    const p = { id: 'devworkspace', healthUrl: 'https://example.com/', healthAllowPrivate: false };
    insertCheck(h.db, 'mock', h.time.t, getProject(h.db, 'devworkspace')!, ok);
    // Same row, different source: the live view must not see it.
    const withUrl = { ...getProject(h.db, 'devworkspace')!, ...p };
    insertCheck(h.db, 'mock', h.time.t, withUrl, ok);
    expect(checkStatus(h.db, withUrl, 'mock', h.time.t, 60000).state).toBe('ok');
    expect(checkStatus(h.db, withUrl, 'live', h.time.t, 60000).state).toBe('pending');
  });
});

describe('private targets need explicit, audited authorization', () => {
  it('rejects private, loopback and Tailscale addresses until a project is authorised', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://192.168.1.113/status',
      'http://10.0.0.2/',
      'http://[::1]/',
      'http://localhost:3000/',
      'http://100.88.33.71/',
    ]) {
      const res = await patch(a, 'nextcloud', { healthUrl: url });
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('health_target_rejected');
    }
    expect(getProject(h.db, 'nextcloud')!.healthUrl).toBeNull();
  });

  it('accepts them once authorised, and records the authorization in the audit log', async () => {
    const s = stubFetcher({ ...ok, targetClass: 'private' });
    const h = makeApp({ fetcher: s.fetcher });
    const a = await signedIn(h);
    const res = await patch(a, 'nextcloud', {
      healthUrl: 'http://192.168.1.113:8080/status.php',
      healthAllowPrivate: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.healthAllowPrivate).toBe(true);
    await vi.waitFor(() =>
      expect(s.calls).toEqual([
        { url: 'http://192.168.1.113:8080/status.php', allowPrivate: true },
      ]),
    );

    const audit = (await a.agent.get('/api/v1/audit')).body.items as {
      action: string;
      target: string;
      detail: { allowed?: boolean };
    }[];
    const grant = audit.find((e) => e.action === 'project.health_private_target');
    expect(grant).toMatchObject({ target: 'nextcloud', detail: { allowed: true } });
  });

  it('refuses link-local and metadata targets even when private access is authorised', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[fe80::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://0.0.0.0/',
    ]) {
      const res = await patch(a, 'nextcloud', { healthUrl: url, healthAllowPrivate: true });
      expect(res.status, url).toBe(400);
    }
  });

  it('refuses non-http schemes and embedded credentials', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    for (const url of [
      'ftp://example.com/',
      'file:///etc/passwd',
      'https://u:p@example.com/',
      'javascript:alert(1)',
    ]) {
      expect((await patch(a, 'nextcloud', { healthUrl: url })).status, url).toBe(400);
    }
  });

  it('cannot withdraw authorization while a private URL is still configured', async () => {
    const h = makeApp({ fetcher: stubFetcher().fetcher });
    const a = await signedIn(h);
    await patch(a, 'nextcloud', { healthUrl: 'http://192.168.1.113/', healthAllowPrivate: true });
    expect((await patch(a, 'nextcloud', { healthAllowPrivate: false })).status).toBe(400);
    const both = await patch(a, 'nextcloud', {
      healthUrl: 'https://example.com/',
      healthAllowPrivate: false,
    });
    expect(both.status).toBe(200);
    const audit = (await a.agent.get('/api/v1/audit')).body.items as {
      action: string;
      detail: { allowed?: boolean };
    }[];
    expect(
      audit
        .filter((e) => e.action === 'project.health_private_target')
        .map((e) => e.detail.allowed),
    ).toEqual([false, true]);
  });

  it('applies the same rules when a project is registered with a URL', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const post = (b: object) =>
      a.agent.post('/api/v1/projects').set('x-csrf-token', a.csrf).send(b);
    expect(
      (await post({ id: 'lan-app', name: 'LAN', healthUrl: 'http://192.168.1.50/' })).status,
    ).toBe(400);
    expect(
      (
        await post({
          id: 'lan-app',
          name: 'LAN',
          healthUrl: 'http://192.168.1.50/',
          healthAllowPrivate: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post({
          id: 'meta',
          name: 'Meta',
          healthUrl: 'http://169.254.169.254/',
          healthAllowPrivate: true,
        })
      ).status,
    ).toBe(400);
  });

  it('requires a signed-in session and a CSRF token to change a health URL', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const noCsrf = await a.agent
      .patch('/api/v1/projects/nextcloud')
      .send({ healthUrl: 'https://example.com/' });
    expect(noCsrf.status).toBe(403);
    const anon = await (
      await import('supertest')
    )
      .default(h.app)
      .patch('/api/v1/projects/nextcloud')
      .send({ healthUrl: 'https://example.com/' });
    expect(anon.status).toBe(401);
  });
});

describe('SSRF enforcement happens at connection time, not just at registration', () => {
  it('blocks a hostname that resolves to a private address, and flags the project', async () => {
    const resolver = async (host: string) =>
      host === 'sneaky.example.com' ? [{ address: '127.0.0.1', family: 4 }] : [];
    const h = makeApp({ fetcher: liveFetcher(resolver) });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    // Looks harmless at registration: it is a hostname, not an IP literal.
    expect(
      (await patch(a, 'devworkspace', { healthUrl: 'https://sneaky.example.com/health' })).status,
    ).toBe(200);
    await vi.waitFor(async () => expect((await projectOf(a)).httpCheck.state).toBe('blocked'));
    const p = await projectOf(a);
    expect(p.httpCheck.error).toMatch(/not permitted/i);
    expect(p.httpCheck.statusCode).toBeNull();
    expect(p.health.status).toBe('degraded');
  });

  it('blocks a hostname that resolves to the metadata address even for an authorised project', async () => {
    const resolver = async () => [{ address: '169.254.169.254', family: 4 }];
    const h = makeApp({ fetcher: liveFetcher(resolver) });
    const a = await signedIn(h);
    await patch(a, 'devworkspace', {
      healthUrl: 'http://metadata.example.com/',
      healthAllowPrivate: true,
    });
    await vi.waitFor(async () => expect((await projectOf(a)).httpCheck.state).toBe('blocked'));
  });

  it('reports DNS failures as a failed check, not a blocked one', async () => {
    const h = makeApp({
      fetcher: liveFetcher(async () => {
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      }),
    });
    const a = await signedIn(h);
    await patch(a, 'devworkspace', { healthUrl: 'https://gone.example.com/' });
    await vi.waitFor(async () => expect((await projectOf(a)).httpCheck.state).toBe('failed'));
    expect((await projectOf(a)).httpCheck.error).toMatch(/dns/i);
  });

  it('never stores or shows the URL, including any query token, in check results', async () => {
    const h = makeApp({ fetcher: liveFetcher(async () => []) });
    const a = await signedIn(h);
    await patch(a, 'devworkspace', {
      healthUrl: 'https://svc.example.com/health?token=supersecret-123',
    });
    await vi.waitFor(async () => expect((await projectOf(a)).httpCheck.state).not.toBe('pending'));
    const rows = h.db.prepare('SELECT * FROM health_checks').all();
    expect(JSON.stringify(rows)).not.toContain('supersecret-123');
    expect(JSON.stringify((await projectOf(a)).httpCheck)).not.toContain('supersecret-123');
  });
});

describe('mock health checker', () => {
  it('honours the target policy without touching the network', async () => {
    const f = mockFetcher();
    expect((await f({ url: 'https://example.com/', allowPrivate: false })).state).toBe('ok');
    expect((await f({ url: 'https://fail.example.com/', allowPrivate: false })).state).toBe(
      'failed',
    );
    expect((await f({ url: 'http://192.168.1.5/', allowPrivate: false })).state).toBe('blocked');
    expect((await f({ url: 'http://192.168.1.5/', allowPrivate: true })).targetClass).toBe(
      'private',
    );
    expect((await f({ url: 'http://169.254.169.254/', allowPrivate: true })).state).toBe('blocked');
  });
});

describe('connectivity', () => {
  it('reports host-agent items as needing the agent, never as measured', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    await h.collector.collectOnce();
    const c = (await a.agent.get('/api/v1/overview')).body.connectivity as {
      id: string;
      state: string;
      detail: string;
    }[];
    for (const id of ['link', 'gateway', 'tailscale'])
      expect(c.find((x) => x.id === id)).toMatchObject({ state: 'needs_host_agent' });
    expect(c.find((x) => x.id === 'tunnel')).toMatchObject({ state: 'unknown' });
    expect(c.find((x) => x.id === 'tunnel')!.detail).toMatch(/does not prove/i);
  });

  it('judges the tunnel by an end-to-end public check plus the container', async () => {
    const s = stubFetcher();
    const h = makeApp({ fetcher: s.fetcher });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    await patch(a, 'devworkspace', { healthUrl: 'https://example.com/healthz' });
    await vi.waitFor(async () => expect((await projectOf(a)).httpCheck.state).toBe('ok'));
    const tunnel = () =>
      a.agent
        .get('/api/v1/overview')
        .then((r) => r.body.connectivity.find((x: { id: string }) => x.id === 'tunnel'));
    expect(await tunnel()).toMatchObject({ state: 'ok' });

    s.state.next = failed;
    await h.checker.runAll();
    expect(await tunnel()).toMatchObject({ state: 'failed' });
  });

  it('does not count private targets as public reachability', async () => {
    const s = stubFetcher({ ...ok, targetClass: 'private' });
    const h = makeApp({ fetcher: s.fetcher });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    await patch(a, 'nextcloud', { healthUrl: 'http://192.168.1.113/', healthAllowPrivate: true });
    await vi.waitFor(async () =>
      expect((await projectOf(a, 'nextcloud')).httpCheck.state).toBe('ok'),
    );
    const pub = (await a.agent.get('/api/v1/overview')).body.connectivity.find(
      (x: { id: string }) => x.id === 'public',
    );
    expect(pub.state).toBe('unknown');
  });
});

/** A provider whose three sources can each be made to fail independently. */
function controllable() {
  const mock = createMockProvider(() => Date.now());
  const mode = { host: 'ok', docker: 'ok', netdata: 'ok' } as Record<
    string,
    'ok' | 'fail' | 'hang'
  >;
  const clock = { t: Date.UTC(2026, 9, 14, 12) };
  let events: ContainerEvent[] = [];
  const provider: Provider = {
    source: 'mock',
    host: async (): Promise<HostSample> => {
      if (mode.host === 'fail') throw new Error('host exploded');
      if (mode.host === 'hang') return new Promise(() => {});
      return { ...(await mock.host()), collectedAt: new Date(clock.t).toISOString() };
    },
    docker: async (): Promise<DockerSnapshot> => {
      if (mode.docker === 'fail') throw new Error('docker exploded');
      if (mode.docker === 'hang') return new Promise(() => {});
      return { ...(await mock.docker()), events };
    },
    netdata: async (): Promise<NetdataExtras> => {
      if (mode.netdata === 'fail') throw new Error('netdata exploded');
      return { netInKbps: 1, netOutKbps: 2, diskReadKiBps: 3, diskWriteKiBps: 4 };
    },
  };
  return { provider, mode, clock, setEvents: (e: ContainerEvent[]) => (events = e) };
}

describe('partial failures', () => {
  it('a failing host does not blank Docker, and the error names the source', async () => {
    const c = controllable();
    c.mode.host = 'fail';
    const h = makeApp({ provider: c.provider });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    const ov = (await a.agent.get('/api/v1/overview')).body;
    expect(ov.host).toMatchObject({ freshness: 'unavailable', data: null });
    expect(ov.docker.freshness).toBe('current');
    expect(ov.collectorErrors.host.message).toMatch(/host exploded/);
    expect(ov.collectorErrors.docker).toBeNull();
    expect(ov.projects.find((p: { id: string }) => p.id === 'devworkspace').health.status).toBe(
      'healthy',
    );
  });

  it('a failing Docker keeps host metrics current while container data goes stale', async () => {
    const c = controllable();
    const h = makeApp({ provider: c.provider });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    c.mode.docker = 'fail';
    h.time.t += 40_000; // more than 2.5 polling intervals
    c.clock.t = h.time.t;
    await h.collector.collectOnce();

    const ov = (await a.agent.get('/api/v1/overview')).body;
    expect(ov.host.freshness).toBe('current');
    expect(ov.docker.freshness).toBe('stale');
    expect(ov.collectorErrors.docker.message).toMatch(/docker exploded/);
    expect(ov.projects.find((p: { id: string }) => p.id === 'devworkspace').health).toEqual({
      status: 'unknown',
      reason: 'Container data is stale',
    });
    const containers = (await a.agent.get('/api/v1/containers')).body;
    expect(containers.freshness).toBe('stale');
    expect(containers.items.length).toBeGreaterThan(0); // last known, clearly labelled stale
  });

  it('a failing Netdata only affects its own reading and recovers by itself', async () => {
    const c = controllable();
    c.mode.netdata = 'fail';
    const h = makeApp({ provider: c.provider });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    let ov = (await a.agent.get('/api/v1/overview')).body;
    expect(ov.netdata).toMatchObject({ configured: true, freshness: 'unavailable', data: null });
    expect(ov.netdata.error).toMatch(/netdata exploded/);
    expect(ov.host.freshness).toBe('current');
    expect(ov.docker.freshness).toBe('current');

    c.mode.netdata = 'ok';
    await h.collector.collectOnce();
    ov = (await a.agent.get('/api/v1/overview')).body;
    expect(ov.netdata).toMatchObject({ freshness: 'current', error: null, data: { netInKbps: 1 } });
  });

  it('times out a source that hangs, without blocking the others', async () => {
    vi.useFakeTimers();
    try {
      const c = controllable();
      c.mode.docker = 'hang';
      const h = makeApp({ provider: c.provider });
      const run = h.collector.collectOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      await run;
      expect(h.collector.errors.docker?.message).toMatch(/timed out/);
      expect(h.collector.errors.host).toBeNull();
      expect(h.collector.containers).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows Netdata as "not configured" when no URL was given', async () => {
    const h = makeApp({
      provider: { ...createMockProvider(() => Date.now()), netdata: undefined } as Provider,
    });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    expect((await a.agent.get('/api/v1/overview')).body.netdata).toEqual({ configured: false });
  });
});

describe('container events', () => {
  const ev = (
    ts: number,
    action = 'die',
    container = 'auth-service',
    exitCode: number | null = 1,
  ): ContainerEvent => ({ ts, container, action, exitCode });

  it('stores events once even when the same ones are reported again', async () => {
    const c = controllable();
    c.setEvents([ev(RECENT + 1000), ev(RECENT + 2000, 'start', 'auth-service', null)]);
    const h = makeApp({ provider: c.provider });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    await h.collector.collectOnce();
    const res = (await a.agent.get('/api/v1/events')).body;
    expect(res.items).toHaveLength(2);
    expect(res.source).toBe('mock');
    expect(res.note).toMatch(/best-effort/i);
    expect(res.items[0]).toMatchObject({
      container: 'auth-service',
      action: 'start',
      exitCode: null,
    });
  });

  it('keeps rapid events from the same second apart using their exact time', async () => {
    const c = controllable();
    c.setEvents([ev(RECENT + 1), ev(RECENT + 2), ev(RECENT + 3)]);
    const h = makeApp({ provider: c.provider });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    expect((await a.agent.get('/api/v1/events')).body.items).toHaveLength(3);
  });

  it('paginates and validates its parameters', async () => {
    const c = controllable();
    c.setEvents(Array.from({ length: 5 }, (_, i) => ev(RECENT + i)));
    const h = makeApp({ provider: c.provider });
    const a = await signedIn(h);
    await h.collector.collectOnce();
    const first = (await a.agent.get('/api/v1/events?limit=2')).body;
    expect(first.items).toHaveLength(2);
    const second = (await a.agent.get(`/api/v1/events?limit=2&before=${first.nextBefore}`)).body;
    expect(second.items.every((e: { id: number }) => e.id < first.nextBefore)).toBe(true);
    expect((await a.agent.get('/api/v1/events?limit=0')).status).toBe(400);
    expect((await a.agent.get('/api/v1/events?limit=9999')).status).toBe(400);
  });

  it('is empty, not mock data, in live mode with nothing collected', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    expect((await a.agent.get('/api/v1/events')).body.items).toEqual([]);
  });
});

describe('mock and live stay separate', () => {
  it('the live provider code cannot reach demo data', () => {
    for (const f of ['live.ts', 'host.ts', 'docker.ts', 'netdata.ts']) {
      const src = readFileSync(new URL(`../src/providers/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/mock/i);
    }
  });
});
