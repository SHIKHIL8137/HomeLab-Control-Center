import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createNetdataAdapter } from '../src/providers/netdata.ts';
import { ProviderUnavailableError } from '../src/providers/types.ts';

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

const NET = { labels: ['time', 'received', 'sent'], data: [[1700000000, 123.456, -45.64]] };
const IO = { labels: ['time', 'in', 'out'], data: [[1700000000, 10.5, -20.25]] };

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };

async function netdata(handler?: (url: URL, res: http.ServerResponse) => boolean | void) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const url = new URL(req.url ?? '', 'http://x');
    if (handler?.(url, res)) return;
    const chart = url.searchParams.get('chart');
    const body = chart === 'system.net' ? NET : chart === 'system.io' ? IO : null;
    if (!body) return void res.writeHead(404).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  servers.push(s);
  const port = await new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)),
  );
  return { url: `http://127.0.0.1:${port}`, seen };
}

const rejects = async (p: Promise<unknown>, re: RegExp) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderUnavailableError);
  expect((err as Error).message).toMatch(re);
};

describe('netdata adapter', () => {
  it('reads network and disk rates, using magnitudes for the negative "sent"/"out" series', async () => {
    const n = await netdata();
    expect(await createNetdataAdapter({ baseUrl: n.url })()).toEqual({
      netInKbps: 123.5,
      netOutKbps: 45.6,
      diskReadKiBps: 10.5,
      diskWriteKiBps: 20.3,
    });
  });

  it('is read-only: GET only, no credentials, and only the two chart queries', async () => {
    const n = await netdata();
    await createNetdataAdapter({ baseUrl: n.url })();
    expect(n.seen).toHaveLength(2);
    for (const r of n.seen) {
      expect(r.method).toBe('GET');
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
      const u = new URL(r.url, 'http://x');
      expect(u.pathname).toBe('/api/v1/data');
      expect(['system.net', 'system.io']).toContain(u.searchParams.get('chart'));
    }
  });

  it('reports that authentication is required instead of asking for a token', async () => {
    const n = await netdata((_u, res) => (res.writeHead(401).end('{"error":"auth"}'), true));
    await rejects(
      createNetdataAdapter({ baseUrl: n.url })(),
      /requires authentication.*no credentials/i,
    );
    const forbidden = await netdata((_u, res) => (res.writeHead(403).end('{}'), true));
    await rejects(createNetdataAdapter({ baseUrl: forbidden.url })(), /requires authentication/i);
  });

  it('tolerates one missing chart but not both', async () => {
    const one = await netdata((u, res) =>
      u.searchParams.get('chart') === 'system.io' ? (res.writeHead(404).end('{}'), true) : false,
    );
    expect(await createNetdataAdapter({ baseUrl: one.url })()).toMatchObject({
      netInKbps: 123.5,
      diskReadKiBps: null,
      diskWriteKiBps: null,
    });
    const none = await netdata((_u, res) => (res.writeHead(404).end('{}'), true));
    await rejects(createNetdataAdapter({ baseUrl: none.url })(), /no system\.net or system\.io/);
  });

  it('leaves unknown values empty when Netdata reports nulls', async () => {
    const n = await netdata((u, res) => {
      if (u.searchParams.get('chart') === 'system.net') {
        res
          .writeHead(200)
          .end(JSON.stringify({ labels: ['time', 'received', 'sent'], data: [[1, null, null]] }));
        return true;
      }
    });
    expect(await createNetdataAdapter({ baseUrl: n.url })()).toMatchObject({
      netInKbps: null,
      netOutKbps: null,
      diskReadKiBps: 10.5,
    });
  });

  it('rejects malformed or unexpected responses', async () => {
    for (const body of [
      '{not json',
      '{"labels":"x"}',
      '{"labels":["time"],"data":[]}',
      '[]',
      '"ok"',
    ]) {
      const n = await netdata((_u, res) => (res.writeHead(200).end(body), true));
      await rejects(createNetdataAdapter({ baseUrl: n.url })(), /unexpected response/i);
    }
  });

  it('rejects an oversized response', async () => {
    const n = await netdata((_u, res) => (res.writeHead(200).end('x'.repeat(200_000)), true));
    await rejects(createNetdataAdapter({ baseUrl: n.url })(), /Netdata unavailable/);
  });

  it('times out a Netdata that does not answer', async () => {
    const n = await netdata(() => true);
    await rejects(
      createNetdataAdapter({ baseUrl: n.url, timeoutMs: 150 })(),
      /Netdata unavailable.*Timed out/,
    );
  });

  it('does not follow redirects', async () => {
    const n = await netdata(
      (_u, res) => (res.writeHead(302, { location: 'http://169.254.169.254/' }).end(), true),
    );
    await rejects(createNetdataAdapter({ baseUrl: n.url })(), /Netdata unavailable/);
    // The two chart queries run in parallel and the first failure rejects the call, so the second
    // may still be in flight: wait for it, then check only the Netdata server was ever contacted.
    await vi.waitFor(() => expect(n.seen).toHaveLength(2));
    expect(n.seen.every((r) => r.url.startsWith('/api/v1/data'))).toBe(true);
  });

  it('reports a refused connection', async () => {
    const n = await netdata();
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    await rejects(
      createNetdataAdapter({ baseUrl: n.url, timeoutMs: 300 })(),
      /Netdata unavailable/,
    );
  });
});

describe('netdata configuration', () => {
  it('is off unless a URL is configured', () => {
    expect(loadConfig({}).netdataUrl).toBeUndefined();
  });

  it('refuses credentials, odd schemes and metadata addresses in the URL', () => {
    for (const u of [
      'http://user:pw@127.0.0.1:19999',
      'ftp://127.0.0.1',
      'file:///x',
      'http://169.254.169.254/',
      'http://[fe80::1]:19999',
      'not a url',
    ]) {
      expect(() => loadConfig({ HLCC_NETDATA_URL: u }), u).toThrow();
    }
  });

  it('accepts a private Netdata address, since that is where it normally lives', () => {
    expect(loadConfig({ HLCC_NETDATA_URL: 'http://192.168.1.113:19999' }).netdataUrl).toBe(
      'http://192.168.1.113:19999',
    );
  });
});
