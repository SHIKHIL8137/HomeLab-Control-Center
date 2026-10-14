import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decide, isCanonicalTarget } from '../src/policy.ts';
import { assertValidToken, createProxy, readToken, type ProxyOptions } from '../src/server.ts';

const TOKEN = 'test-only-proxy-token-0123456789abcdef0123456789';
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

const listen = (s: http.Server) => {
  servers.push(s);
  return new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)),
  );
};

/** A fake Docker that records the paths it was asked for. */
async function stack(opts: { handler?: http.RequestListener; proxy?: Partial<ProxyOptions> } = {}) {
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if (opts.handler) return opts.handler(req, res);
    res.writeHead(200).end(req.url === '/info' ? '{"MemTotal":1}' : '[]');
  });
  const up = await listen(upstream);
  const proxyPort = await listen(
    createProxy({ host: '127.0.0.1', port: up }, { token: TOKEN, ...opts.proxy }),
  );
  return { seen, proxyPort };
}

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers });

describe('authentication', () => {
  it('rejects missing, malformed and wrong credentials before touching Docker', async () => {
    const { proxyPort, seen } = await stack();
    const bad: Record<string, string>[] = [
      {},
      { authorization: '' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: `Basic ${TOKEN}` },
      { authorization: TOKEN },
      { authorization: `bearer ${TOKEN}` },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${'a'.repeat(TOKEN.length)}` },
      { authorization: `Bearer ${TOKEN} extra` },
      { authorization: `Bearer ${'a'.repeat(5000)}` },
      { 'x-api-key': TOKEN },
    ];
    for (const h of bad) {
      const res = await get(proxyPort, '/info', h);
      expect(res.status, JSON.stringify(Object.keys(h))).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
    expect(seen).toEqual([]);
  });

  it('accepts the right credential', async () => {
    const { proxyPort, seen } = await stack();
    const res = await get(proxyPort, '/info', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['/info']);
  });

  it('does not tell an unauthenticated caller which routes exist', async () => {
    const { proxyPort } = await stack();
    const statuses = await Promise.all(
      ['/info', '/containers/x/logs', '/images/json', '/nothing'].map(
        async (p) => (await get(proxyPort, p)).status,
      ),
    );
    expect(new Set(statuses)).toEqual(new Set([401]));
    const post = await fetch(`http://127.0.0.1:${proxyPort}/containers/x/stop`, { method: 'POST' });
    expect(post.status).toBe(401); // not 405: authentication is checked before anything else
  });

  it('never echoes the credential, even on errors', async () => {
    const { proxyPort } = await stack({ handler: (_q, r) => r.writeHead(500).end(TOKEN) });
    const res = await get(proxyPort, '/info', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it('refuses to be created without a strong token (fails closed)', () => {
    const up = { host: '127.0.0.1', port: 1 };
    for (const t of [
      '',
      'short',
      'a'.repeat(31),
      'has space in it but is long enough 0123456789',
      'x'.repeat(40) + '\n',
      undefined as unknown as string,
    ]) {
      expect(() => createProxy(up, { token: t }), JSON.stringify(t)).toThrow(/at least 32/);
    }
    expect(() => assertValidToken(TOKEN)).not.toThrow();
  });

  it('refuses a long but trivially guessable token', () => {
    for (const weak of ['a'.repeat(64), 'ab'.repeat(32), '0123456789'.repeat(5), '1'.repeat(40)]) {
      expect(() => assertValidToken(weak), weak.slice(0, 12)).toThrow(/repetitive/);
      expect(() => createProxy({ host: '127.0.0.1', port: 1 }, { token: weak })).toThrow(
        /repetitive/,
      );
    }
  });

  it('reads the token from a file, refuses both sources at once, and trims whitespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hlcc-token-'));
    const file = join(dir, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    expect(readToken({ PROXY_TOKEN_FILE: file })).toBe(TOKEN);
    expect(readToken({ PROXY_TOKEN: TOKEN })).toBe(TOKEN);
    expect(() => readToken({ PROXY_TOKEN_FILE: file, PROXY_TOKEN: TOKEN })).toThrow(/only one/);
    expect(() => readToken({})).toThrow(/at least 32/);
    writeFileSync(file, 'short\n');
    expect(() => readToken({ PROXY_TOKEN_FILE: file })).toThrow(/at least 32/);
  });

  it('keeps the token out of error messages', () => {
    try {
      assertValidToken('weak-secret-value');
    } catch (e) {
      expect((e as Error).message).not.toContain('weak-secret-value');
    }
  });
});

describe('canonical request targets', () => {
  it.each([
    '//evil.example/containers/json',
    '//containers/json',
    '///containers/json',
    '/containers/../info',
    '/containers/./x/json',
    '/containers//json',
    '/./info',
    '/../info',
    '/info/..',
    '/containers/json/',
    '/%63ontainers/json',
    '/containers/%2e%2e/json',
    '/containers/..%2finfo/json',
    '/containers/x%2fjson',
    '/containers/x\\json',
    '\\containers\\json',
    '/containers/json#frag',
    '/containers/json?all=true#frag',
    '/info\t',
    '/info\n',
    '/info\r\nHost: x',
    '/info ',
    ' /info',
    'http://127.0.0.1/info',
    'http://evil.example/containers/json',
    '*',
    'info',
    '',
    '/containers/json\u0000',
    '/ｉｎｆｏ', // full-width characters that a lenient parser might fold
    '/containers/json?all=true&all=false',
    '/containers/json?all=true;x=1',
    '/containers/json?%61ll=true',
    '/containers/json?all=tr%75e',
  ])('refuses the non-canonical target %j', (raw) => {
    expect(decide('GET', raw).ok).toBe(false);
  });

  it('still accepts the exact canonical spellings', () => {
    for (const raw of [
      '/_ping',
      '/info',
      '/containers/json',
      '/containers/json?all=true',
      '/containers/abc123/json',
    ]) {
      expect(isCanonicalTarget(raw), raw).toBe(true);
      expect(decide('GET', raw).ok, raw).toBe(true);
    }
  });

  it('refuses API-version prefixes and case variants', () => {
    for (const raw of ['/v1.43/info', '/v1.43/containers/json', '/INFO', '/Containers/json']) {
      expect(decide('GET', raw).ok, raw).toBe(false);
    }
  });

  it('refuses every method except GET, however it is spelled', () => {
    for (const m of [
      'get',
      'Get',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
      'TRACE',
      'CONNECT',
      'PROPFIND',
      'COPY',
      'LINK',
      '',
      undefined,
    ]) {
      expect(decide(m, '/info').ok, String(m)).toBe(false);
    }
  });

  it('never forwards the raw request target', () => {
    const d = decide('GET', '/containers/json?all=true');
    expect(d.ok && d.upstreamPath).toBe('/containers/json?all=1');
  });
});

describe('request handling limits', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it('rejects request bodies and never contacts Docker for them', async () => {
    const { proxyPort, seen } = await stack();
    // fetch() silently drops a GET body, so speak raw HTTP.
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(proxyPort, '127.0.0.1', () =>
        s.write(
          `GET /info HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`,
        ),
      );
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('close', () => resolve(buf));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    expect(seen).toEqual([]);
  });

  it('answers 503 beyond the concurrency cap, and recovers afterwards', async () => {
    const release: (() => void)[] = [];
    const { proxyPort } = await stack({
      handler: (_q, r) => release.push(() => r.writeHead(200).end('{"MemTotal":1}')),
      proxy: { maxInflight: 2 },
    });
    const a = get(proxyPort, '/info', auth);
    const b = get(proxyPort, '/info', auth);
    await new Promise((r) => setTimeout(r, 100));
    const c = await get(proxyPort, '/info', auth);
    expect(c.status).toBe(503);
    release.forEach((f) => f());
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    release.length = 0;
    const d = get(proxyPort, '/info', auth);
    await new Promise((r) => setTimeout(r, 50));
    release.forEach((f) => f());
    expect((await d).status).toBe(200);
  });

  it('cancels the Docker request when the client goes away', async () => {
    let upstreamClosed = false;
    const { proxyPort, seen } = await stack({
      handler: (_q, r) => {
        r.on('close', () => (upstreamClosed = true));
      },
    });
    const ctl = new AbortController();
    const p = get(proxyPort, '/info', auth).catch(() => null);
    void ctl;
    // Use a raw socket so we can hang up mid-request.
    const sock = net.connect(proxyPort, '127.0.0.1', () =>
      sock.write(`GET /info HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`),
    );
    await new Promise((r) => setTimeout(r, 150));
    sock.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(upstreamClosed).toBe(true);
    void p;
  });

  it('survives a client that sends garbage, half a request, or nothing', async () => {
    const { proxyPort } = await stack();
    for (const payload of [
      '\x00\x01\x02garbage\r\n\r\n',
      'GET /info HTTP/1.1\r\nHost: x\r\n',
      'POST / HTTP/9.9\r\n\r\n',
      '',
    ]) {
      await new Promise<void>((resolve) => {
        const s = net.connect(proxyPort, '127.0.0.1', () => {
          s.write(payload);
          setTimeout(() => s.destroy(), 100);
        });
        s.on('error', () => resolve());
        s.on('close', () => resolve());
      });
    }
    const ok = await get(proxyPort, '/_ping', auth);
    expect([200, 502]).toContain(ok.status); // still serving requests
    expect(ok.status).not.toBe(401);
  });

  it('closes a connection that never finishes sending its headers', async () => {
    const { proxyPort } = await stack();
    const t0 = Date.now();
    const result = await new Promise<{ closed: boolean; ms: number; got: string }>((resolve) => {
      let got = '';
      const s = net.connect(proxyPort, '127.0.0.1', () =>
        s.write('GET /info HTTP/1.1\r\nHost: x\r\n'),
      );
      s.on('data', (d) => (got += d));
      s.on('close', () => resolve({ closed: true, ms: Date.now() - t0, got: got.slice(0, 30) }));
      s.on('error', () => resolve({ closed: true, ms: Date.now() - t0, got: 'error' }));
      setTimeout(() => resolve({ closed: false, ms: Date.now() - t0, got }), 8_000);
    });
    expect(JSON.stringify(result)).toContain('"closed":true');
    expect(result.ms).toBeLessThan(7_000);
  }, 12_000);

  it('rejects an oversized upstream body arriving in one chunk', async () => {
    const { proxyPort } = await stack({
      handler: (_q, r) => r.writeHead(200).end('x'.repeat(9 * 1024 * 1024)),
    });
    expect((await get(proxyPort, '/info', auth)).status).toBe(502);
  });

  it('answers 502 for malformed JSON and upstream failures without leaking detail', async () => {
    const bad = await stack({ handler: (_q, r) => r.writeHead(200).end('{not json') });
    const res = await get(bad.proxyPort, '/info', auth);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":"Docker is unavailable"}');
  });

  it('times out a stalled Docker', async () => {
    const { proxyPort } = await stack({ handler: () => {}, proxy: { timeoutMs: 150 } });
    expect((await get(proxyPort, '/info', auth)).status).toBe(502);
  });
});
