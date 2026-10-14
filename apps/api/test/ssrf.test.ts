import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyIp, guardedGet, validateTarget } from '../src/security/ssrf.ts';

describe('classifyIp', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['93.184.216.34', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.113', 'private'],
    ['127.0.0.1', 'private'],
    ['100.88.33.71', 'private'], // Tailscale
    ['::1', 'private'],
    ['0:0:0:0:0:0:0:1', 'private'],
    ['fd7a:115c:a1e0::e01:21ba', 'private'], // Tailscale ULA
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['169.254.169.254', 'blocked'], // cloud metadata
    ['169.254.0.1', 'blocked'],
    ['0.0.0.0', 'blocked'],
    ['0.1.2.3', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['255.255.255.255', 'blocked'],
    ['240.0.0.1', 'blocked'],
    ['192.0.0.170', 'blocked'],
    ['198.18.0.1', 'blocked'],
    ['fe80::1', 'blocked'],
    ['ff02::1', 'blocked'],
    ['::', 'blocked'],
    ['::2', 'blocked'],
    ['fd00:ec2::254', 'blocked'], // AWS IPv6 metadata inside the ULA range
    ['::ffff:169.254.169.254', 'blocked'],
    ['::ffff:a9fe:a9fe', 'blocked'],
    ['64:ff9b::7f00:1', 'blocked'], // NAT64 embedding 127.0.0.1
    ['2002:7f00:1::', 'blocked'], // 6to4 embedding 127.0.0.1
    ['not-an-ip', 'blocked'],
    ['', 'blocked'],
    ['1.2.3', 'blocked'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyIp(ip)).toBe(cls);
  });
});

describe('validateTarget', () => {
  it('accepts public hosts and rejects bad schemes and credentials', () => {
    expect(validateTarget('https://example.com/health', false).ok).toBe(true);
    for (const u of [
      'ftp://example.com',
      'file:///etc/passwd',
      'gopher://x',
      'javascript:alert(1)',
      'not a url',
      'https://user:pw@example.com/',
    ]) {
      expect(validateTarget(u, true).ok, u).toBe(false);
    }
  });

  it('requires explicit authorization for private literals and loopback names', () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://192.168.1.113:8080/',
      'http://10.1.2.3/',
      'http://[::1]/',
      'http://localhost/',
      'http://app.localhost/',
      'http://100.88.33.71/',
    ]) {
      expect(validateTarget(u, false).ok, u).toBe(false);
      expect(validateTarget(u, true).ok, u).toBe(true);
    }
  });

  it('never allows link-local or metadata addresses, even when private is authorized', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data',
      'http://[fe80::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://0.0.0.0/',
    ]) {
      expect(validateTarget(u, true).ok, u).toBe(false);
    }
  });

  it('sees through numeric obfuscation of loopback', () => {
    // The URL parser normalises these to 127.0.0.1 before classification.
    for (const u of [
      'http://2130706433/',
      'http://0x7f.1/',
      'http://017700000001/',
      'http://127.1/',
    ]) {
      expect(validateTarget(u, false).ok, u).toBe(false);
    }
  });
});

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

function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );
}

const resolveTo =
  (map: Record<string, string[]>, counter?: { n: number }) => async (host: string) => {
    if (counter) counter.n++;
    const addrs = map[host];
    if (!addrs) throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

describe('guardedGet: targets', () => {
  it('refuses a private literal unless authorised, and reports what it reached', async () => {
    const port = await serve((_q, r) => r.writeHead(200).end('ok'));
    const denied = await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: false });
    expect(denied).toMatchObject({ ok: false, failure: 'blocked', statusCode: null });
    const allowed = await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    expect(allowed).toMatchObject({
      ok: true,
      statusCode: 200,
      targetClass: 'private',
      failure: null,
    });
  });

  it('validates the resolved address of a hostname, not just the name', async () => {
    const port = await serve((_q, r) => r.writeHead(200).end('ok'));
    const resolver = resolveTo({ 'internal.test': ['127.0.0.1'] });
    expect(
      (await guardedGet(`http://internal.test:${port}/`, { allowPrivate: false, resolver }))
        .failure,
    ).toBe('blocked');
    expect(
      (await guardedGet(`http://internal.test:${port}/`, { allowPrivate: true, resolver })).ok,
    ).toBe(true);
  });

  it('rejects a mixed answer: one bad address poisons the whole reply', async () => {
    const resolver = resolveTo({
      'mixed.test': ['8.8.8.8', '127.0.0.1'],
      'meta.test': ['93.184.216.34', '169.254.169.254'],
    });
    expect(
      (await guardedGet('http://mixed.test/', { allowPrivate: false, resolver })).failure,
    ).toBe('blocked');
    // Even an authorised project cannot reach the metadata address through a hostname.
    expect((await guardedGet('http://meta.test/', { allowPrivate: true, resolver })).failure).toBe(
      'blocked',
    );
  });

  it('blocks IPv4-mapped IPv6 and metadata literals', async () => {
    const resolver = resolveTo({ 'mapped.test': ['::ffff:127.0.0.1'] });
    expect(
      (await guardedGet('http://mapped.test/', { allowPrivate: false, resolver })).failure,
    ).toBe('blocked');
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/',
      'http://[fd00:ec2::254]/',
      'http://[fe80::1]/',
    ]) {
      expect((await guardedGet(u, { allowPrivate: true })).failure, u).toBe('blocked');
    }
  });

  it('blocks obfuscated loopback literals', async () => {
    for (const u of [
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://017700000001/',
      'http://127.1/',
    ]) {
      expect((await guardedGet(u, { allowPrivate: false })).failure, u).toBe('blocked');
    }
  });

  it('rejects odd schemes, credentials and garbage before any connection', async () => {
    for (const u of [
      'ftp://example.com/',
      'file:///etc/passwd',
      'https://user:pw@example.com/',
      'nonsense',
    ]) {
      expect((await guardedGet(u, { allowPrivate: true })).failure, u).toBe('invalid_url');
    }
  });

  it('reports DNS failures separately', async () => {
    const r = await guardedGet('http://nowhere.test/', {
      allowPrivate: false,
      resolver: resolveTo({}),
    });
    expect(r).toMatchObject({ ok: false, failure: 'dns' });
  });
});

describe('guardedGet: DNS rebinding', () => {
  it('re-resolves on every hop, so a name that changes its answer is caught', async () => {
    const calls = { n: 0 };
    let port = 0;
    // First answer: loopback (authorised). Second answer, for the redirect hop: metadata address.
    const resolver = async (host: string) => {
      calls.n++;
      if (host !== 'rebind.test') throw new Error('unexpected host');
      return [{ address: calls.n === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }];
    };
    port = await serve((_q, r) =>
      r.writeHead(302, { location: `http://rebind.test:${port}/second` }).end(),
    );
    const r = await guardedGet(`http://rebind.test:${port}/first`, {
      allowPrivate: true,
      resolver,
    });
    expect(r.failure).toBe('blocked');
    expect(calls.n).toBe(2);
  });
});

describe('guardedGet: redirects', () => {
  it('follows same-origin redirects and reports the final status', async () => {
    const port = await serve((q, r) => {
      if (q.url === '/a') return r.writeHead(301, { location: '/b' }).end();
      if (q.url === '/b') return r.writeHead(302, { location: `http://127.0.0.1:${port}/c` }).end();
      r.writeHead(200).end('ok');
    });
    const r = await guardedGet(`http://127.0.0.1:${port}/a`, { allowPrivate: true });
    expect(r).toMatchObject({ ok: true, statusCode: 200 });
  });

  it('stops after the redirect limit', async () => {
    const port = await serve((_q, r) => r.writeHead(302, { location: '/loop' }).end());
    const r = await guardedGet(`http://127.0.0.1:${port}/loop`, {
      allowPrivate: true,
      maxRedirects: 3,
    });
    expect(r).toMatchObject({ ok: false, failure: 'redirect' });
  });

  it('never lets a redirect pivot from an authorised private host to another private host', async () => {
    const resolver = resolveTo({ 'other.test': ['127.0.0.1'] });
    const port = await serve((_q, r) =>
      r.writeHead(302, { location: `http://other.test:${port}/x` }).end(),
    );
    const r = await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true, resolver });
    expect(r.failure).toBe('blocked');
  });

  it.each([
    ['metadata literal', 'http://169.254.169.254/latest/meta-data/', 'blocked'],
    ['another loopback port', 'http://127.0.0.1:1/', 'blocked'],
    ['IPv6 loopback', 'http://[::1]/', 'blocked'],
    ['file scheme', 'file:///etc/passwd', 'redirect'],
    ['gopher scheme', 'gopher://127.0.0.1/', 'redirect'],
    ['credentials in target', 'http://user:pw@127.0.0.1/', 'redirect'],
  ])('refuses a redirect to %s', async (_label, target, failure) => {
    const port = await serve((_q, r) => r.writeHead(302, { location: target }).end());
    // allowPrivate is false for the hop because the origin differs from the first URL's.
    const r = await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    expect(r.failure).toBe(failure);
  });

  it('treats a 3xx without a Location header as a plain non-OK answer', async () => {
    const port = await serve((_q, r) => r.writeHead(304).end());
    expect(await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true })).toMatchObject({
      ok: false,
      statusCode: 304,
      failure: null,
    });
  });
});

describe('guardedGet: responses', () => {
  it('treats non-2xx as not ok without a transport failure', async () => {
    const port = await serve((_q, r) => r.writeHead(503).end('down'));
    expect(await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true })).toMatchObject({
      ok: false,
      statusCode: 503,
      failure: null,
    });
  });

  it('times out a server that never answers', async () => {
    const port = await serve(() => {
      /* never respond */
    });
    const r = await guardedGet(`http://127.0.0.1:${port}/`, {
      allowPrivate: true,
      timeoutMs: 150,
      overallMs: 1000,
    });
    expect(r).toMatchObject({ ok: false, failure: 'timeout' });
  });

  it('enforces the overall deadline even when every hop is fast enough', async () => {
    const port = await serve((_q, r) => {
      setTimeout(() => r.writeHead(302, { location: '/again' }).end(), 120);
    });
    const r = await guardedGet(`http://127.0.0.1:${port}/`, {
      allowPrivate: true,
      timeoutMs: 1000,
      overallMs: 250,
      maxRedirects: 10,
    });
    expect(r.failure).toBe('timeout');
  });

  it('reports a refused connection', async () => {
    const port = await serve((_q, r) => r.end());
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    const r = await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true, timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, failure: 'connect' });
  });

  it('discards the body unless asked to read it', async () => {
    const port = await serve((_q, r) => r.writeHead(200).end('x'.repeat(5_000_000)));
    const r = await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    expect(r.ok).toBe(true);
    expect(r.body).toBeUndefined();
  });

  it('returns a small body and refuses an oversized one', async () => {
    const port = await serve((q, r) =>
      r.writeHead(200).end(q.url === '/big' ? 'x'.repeat(10_000) : '{"a":1}'),
    );
    const small = await guardedGet(`http://127.0.0.1:${port}/s`, {
      allowPrivate: true,
      readBody: { maxBytes: 1000 },
    });
    expect(small.body).toBe('{"a":1}');
    const big = await guardedGet(`http://127.0.0.1:${port}/big`, {
      allowPrivate: true,
      readBody: { maxBytes: 1000 },
    });
    expect(big).toMatchObject({ ok: false, failure: 'too_large' });
  });

  it('sends no cookies or authorization and identifies itself', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const port = await serve((q, r) => {
      seen = q.headers;
      r.writeHead(200).end('ok');
    });
    await guardedGet(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(String(seen['user-agent'])).toMatch(/HomeLabControlCenter/);
  });

  it('never puts the target URL in its failure message', async () => {
    const r = await guardedGet('http://127.0.0.1:1/secret-token-abc?key=hunter2', {
      allowPrivate: true,
      timeoutMs: 300,
    });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|secret-token/);
  });
});
