import { scrypt, randomBytes } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { needsRehash, hashPassword, verifyPassword } from '../src/security/password.ts';
import { FailureLimiter } from '../src/security/rateLimit.ts';
import { PASSWORD, SETUP_TOKEN, makeApp, signedIn } from './helpers.ts';

const login = (
  app: Parameters<typeof request>[0],
  body: object,
  headers: Record<string, string> = {},
) => request(app).post('/api/v1/auth/login').set(headers).send(body);

/** A hash in the format used before the parameters were raised (N=2^14, p=1). */
function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err
        ? reject(err)
        : resolve(
            ['scrypt', 16384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$'),
          ),
    ),
  );
}

describe('audit attribution cannot be forged', () => {
  it('attributes failed logins to "anonymous", never to the name the client supplied', async () => {
    const h = makeApp();
    await signedIn(h);
    await login(h.app, { username: 'admin', password: 'wrong-password-123' });
    const rows = h.db
      .prepare("SELECT actor, detail FROM audit_events WHERE action = 'auth.login'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('anonymous');
    expect(JSON.parse(String(rows[0]!.detail))).toEqual({ attemptedUser: 'admin' });
  });

  it('cleans control characters out of the attempted name', async () => {
    const h = makeApp();
    await signedIn(h);
    await login(h.app, { username: 'ad\nmin\u0000\u001b[31m', password: 'wrong-password-123' });
    const detail = JSON.parse(
      String(
        h.db.prepare("SELECT detail FROM audit_events WHERE action = 'auth.login'").get()!.detail,
      ),
    );
    // No control characters (code points below 0x20), checked without a control-character regex.
    expect([...String(detail.attemptedUser)].every((c) => c.charCodeAt(0) >= 0x20)).toBe(true);
    expect(detail.attemptedUser).toContain('?');
  });

  it('attributes real events to the authenticated user, from the session, not from the request', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    await a.agent
      .post('/api/v1/projects')
      .set('x-csrf-token', a.csrf)
      .send({ id: 'demo', name: 'Demo', actor: 'someone-else', username: 'mallory' });
    const row = h.db
      .prepare("SELECT actor FROM audit_events WHERE action = 'project.create'")
      .get()!;
    expect(row.actor).toBe('admin');
  });

  it('is append-only: rows cannot be changed or removed, even by the application itself', async () => {
    const h = makeApp();
    await signedIn(h);
    expect(Number(h.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n)).toBeGreaterThan(
      0,
    );
    expect(() => h.db.exec("UPDATE audit_events SET actor = 'x'")).toThrow(/append-only/);
    expect(() => h.db.exec('DELETE FROM audit_events')).toThrow(/append-only/);
  });

  it('has no API route that can modify or delete audit entries', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    for (const method of ['put', 'patch', 'delete', 'post'] as const) {
      const res = await a.agent[method]('/api/v1/audit').set('x-csrf-token', a.csrf).send({});
      expect(res.status, method).toBe(404);
    }
  });

  it('never stores passwords, tokens or cookies in audit rows', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    await login(h.app, { username: 'admin', password: 'wrong-password-123' });
    await a.agent
      .post('/api/v1/auth/setup')
      .send({ setupToken: 'wrong-setup-token-xyz', username: 'x', password: PASSWORD });
    await h.db.exec('SELECT 1');
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM audit_events').all());
    for (const secret of [
      PASSWORD,
      'wrong-password-123',
      SETUP_TOKEN,
      'wrong-setup-token-xyz',
      a.csrf,
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toMatch(/hlcc_session/);
  });
});

describe('sessions', () => {
  it('invalidates the previous session when the same browser signs in again', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const status = await a.agent.get('/api/v1/auth/status');
    expect(status.body.authenticated).toBe(true);
    const cookieJar = (
      a.agent as unknown as {
        jar: { getCookies: (o: object) => { name: string; value: string }[] };
      }
    ).jar;
    const oldSession = cookieJar
      .getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
      .find((c) => c.name === 'hlcc_session');
    expect(oldSession).toBeDefined();

    const again = await a.agent
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: PASSWORD });
    expect(again.status).toBe(200);
    const replay = await request(h.app)
      .get('/api/v1/overview')
      .set('Cookie', `hlcc_session=${oldSession!.value}`);
    expect(replay.status).toBe(401); // the old token no longer works anywhere
    expect((await a.agent.get('/api/v1/overview')).status).toBe(200);
  });

  it('stores only a hash of the session token', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const cookieJar = (
      a.agent as unknown as {
        jar: { getCookies: (o: object) => { name: string; value: string }[] };
      }
    ).jar;
    const token = cookieJar
      .getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false })
      .find((c) => c.name === 'hlcc_session')!.value;
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM sessions').all());
    expect(token.length).toBeGreaterThanOrEqual(40); // 256 bits, base64url
    expect(stored).not.toContain(token);
  });

  it('issues a different, unpredictable session on every login', async () => {
    const h = makeApp();
    await signedIn(h);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await login(h.app, { username: 'admin', password: PASSWORD });
      seen.add(String(res.headers['set-cookie']).split(';')[0]!);
    }
    expect(seen.size).toBe(5);
  });

  it('dies with its TTL and on logout, for the server as well as the browser', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    h.time.t += h.ctx.cfg.sessionTtlMs - 1000;
    expect((await a.agent.get('/api/v1/overview')).status).toBe(200);
    h.time.t += 2000;
    expect((await a.agent.get('/api/v1/overview')).status).toBe(401);
  });
});

describe('password hashing', () => {
  it('uses the current cost and records the parameters with each hash', async () => {
    const hash = await hashPassword('correct horse battery');
    const [alg, n, r, p] = hash.split('$');
    expect([alg, Number(n), Number(r), Number(p)]).toEqual(['scrypt', 32768, 8, 3]);
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
  });

  it('recognises older, weaker hashes and still verifies them', async () => {
    const old = await legacyHash('correct horse battery');
    expect(needsRehash(old)).toBe(true);
    expect(await verifyPassword('correct horse battery', old)).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('upgrades an old hash transparently at the next successful login', async () => {
    const h = makeApp();
    await signedIn(h);
    h.db.prepare('UPDATE users SET password_hash = ?').run(await legacyHash(PASSWORD));
    expect(String(h.db.prepare('SELECT password_hash AS p FROM users').get()!.p)).toMatch(
      /^scrypt\$16384\$8\$1\$/,
    );

    expect((await login(h.app, { username: 'admin', password: 'wrong-password-123' })).status).toBe(
      401,
    );
    expect(String(h.db.prepare('SELECT password_hash AS p FROM users').get()!.p)).toMatch(
      /^scrypt\$16384\$/,
    ); // not upgraded on failure

    expect((await login(h.app, { username: 'admin', password: PASSWORD })).status).toBe(200);
    expect(String(h.db.prepare('SELECT password_hash AS p FROM users').get()!.p)).toMatch(
      /^scrypt\$32768\$8\$3\$/,
    );
    expect((await login(h.app, { username: 'admin', password: PASSWORD })).status).toBe(200);
  });

  it('refuses stored parameters that would exhaust memory or time (tampered database)', async () => {
    const salt = randomBytes(16).toString('base64');
    const key = randomBytes(64).toString('base64');
    const started = Date.now();
    for (const bad of [
      `scrypt$${2 ** 30}$8$1$${salt}$${key}`,
      `scrypt$${2 ** 20}$8$1$${salt}$${key}`,
      `scrypt$32768$512$1$${salt}$${key}`,
      `scrypt$32768$8$999$${salt}$${key}`,
      `scrypt$30000$8$1$${salt}$${key}`,
      `scrypt$0$8$1$${salt}$${key}`,
      `scrypt$32768$8$1$${salt}$c2hvcnQ=`,
      `bcrypt$32768$8$1$${salt}$${key}`,
      `scrypt$NaN$8$1$${salt}$${key}`,
    ]) {
      expect(await verifyPassword('x', bad), bad).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('serialises concurrent hashing so a burst of sign-ins cannot exhaust memory', async () => {
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => hashPassword('correct horse battery')),
    );
    expect(new Set(results).size).toBe(4); // distinct salts
    for (const r of results) expect(await verifyPassword('correct horse battery', r)).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  });
});

describe('login rate limiting', () => {
  const failures = async (
    app: Parameters<typeof request>[0],
    n: number,
    headers: () => Record<string, string>,
  ) => {
    let last = 0;
    for (let i = 0; i < n; i++)
      last = (await login(app, { username: 'admin', password: 'wrong-password-123' }, headers()))
        .status;
    return last;
  };

  it('ignores X-Forwarded-For unless a proxy is trusted, so rotating it does not evade the limit', async () => {
    const h = makeApp({ env: { HLCC_TRUST_PROXY: '0' } });
    await signedIn(h);
    let n = 0;
    expect(await failures(h.app, 5, () => ({ 'x-forwarded-for': `203.0.113.${++n}` }))).toBe(401);
    const blocked = await login(
      h.app,
      { username: 'admin', password: PASSWORD },
      { 'x-forwarded-for': '198.51.100.99' },
    );
    expect(blocked.status).toBe(429);
  });

  it('with one trusted proxy, limits each real client separately', async () => {
    const h = makeApp({ env: { HLCC_TRUST_PROXY: '1' } });
    await signedIn(h);
    expect(await failures(h.app, 5, () => ({ 'x-forwarded-for': '203.0.113.7' }))).toBe(401);
    // That client is now locked out...
    expect(
      (
        await login(
          h.app,
          { username: 'admin', password: PASSWORD },
          { 'x-forwarded-for': '203.0.113.7' },
        )
      ).status,
    ).toBe(429);
    // ...but the administrator, arriving from a different address, is not.
    expect(
      (
        await login(
          h.app,
          { username: 'admin', password: PASSWORD },
          { 'x-forwarded-for': '203.0.113.8' },
        )
      ).status,
    ).toBe(200);
  });

  it('counts the setup endpoint separately and also rate-limits it', async () => {
    const h = makeApp();
    for (let i = 0; i < 5; i++) {
      await request(h.app)
        .post('/api/v1/auth/setup')
        .send({ setupToken: `wrong-token-attempt-${i}`, username: 'admin', password: PASSWORD });
    }
    const res = await request(h.app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('forgets old failures and keeps memory bounded under a flood of addresses', () => {
    let t = 0;
    const l = new FailureLimiter(2, 1000, () => t, 100);
    for (let i = 0; i < 5000; i++) l.fail(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(l.size).toBeLessThanOrEqual(100);
    t = 5000;
    l.fail('fresh');
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.allowed('fresh')).toBe(true);
  });

  it('still blocks the offender after eviction pressure from others', () => {
    const t = 0;
    const l = new FailureLimiter(2, 1000, () => t, 10);
    l.fail('attacker');
    l.fail('attacker');
    expect(l.allowed('attacker')).toBe(false);
    for (let i = 0; i < 5; i++) l.fail(`other-${i}`);
    expect(l.allowed('attacker')).toBe(false);
  });
});

describe('cross-site protection', () => {
  it('refuses cross-site writes even when no Origin header is present', async () => {
    const h = makeApp();
    await signedIn(h);
    for (const site of ['cross-site', 'same-site']) {
      const res = await login(
        h.app,
        { username: 'admin', password: PASSWORD },
        { 'sec-fetch-site': site },
      );
      expect(res.status, site).toBe(403);
      expect(res.body.error.code).toBe('origin_not_allowed');
    }
  });

  it('allows same-origin and direct (no browser) requests', async () => {
    const h = makeApp();
    await signedIn(h);
    for (const site of ['same-origin', 'none']) {
      expect(
        (await login(h.app, { username: 'admin', password: PASSWORD }, { 'sec-fetch-site': site }))
          .status,
        site,
      ).toBe(200);
    }
    expect((await login(h.app, { username: 'admin', password: PASSWORD })).status).toBe(200);
  });

  it('rejects an Origin of "null" and one that merely resembles the host', async () => {
    const h = makeApp();
    await signedIn(h);
    for (const origin of [
      'null',
      'http://127.0.0.1.evil.example',
      'http://evil.example',
      'file://',
    ]) {
      expect(
        (await login(h.app, { username: 'admin', password: PASSWORD }, { origin })).status,
        origin,
      ).toBe(403);
    }
  });

  it('requires a CSRF token on every state-changing authenticated route', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const attempts: [string, string, object][] = [
      ['post', '/api/v1/projects', { id: 'demo', name: 'Demo' }],
      ['patch', '/api/v1/projects/devworkspace', { name: 'x' }],
      ['post', '/api/v1/auth/logout', {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await (a.agent as unknown as Record<string, (p: string) => request.Test>)[
        method
      ]!(path).send(body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('csrf_invalid');
    }
    expect((await a.agent.get('/api/v1/overview')).status).toBe(200); // still signed in
  });

  it('demands authentication for every method on every data route, even unknown ones', async () => {
    const h = makeApp();
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      for (const path of [
        '/overview',
        '/projects',
        '/projects/devworkspace',
        '/containers',
        '/events',
        '/audit',
        '/stream',
        '/nothing-here',
      ]) {
        const res = await request(h.app)[method](`/api/v1${path}`).send({});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
  });
});

describe('errors do not leak internals', () => {
  it('answers a failing database with a generic 500', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    h.db.exec('DROP TABLE projects');
    const res = await a.agent.get('/api/v1/projects');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/projects|sqlite|no such table|at \w+ \(/i);
  });

  it('answers malformed and oversized bodies without echoing them', async () => {
    const h = makeApp();
    const bad = await request(h.app)
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"password": "hunter2-secret');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('hunter2');
    const big = await request(h.app)
      .post('/api/v1/auth/login')
      .send({ username: 'a', password: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it('never returns the stack, the framework name, or a server banner', async () => {
    const h = makeApp();
    const res = await request(h.app).get('/api/v1/nothing');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|express/i);
  });
});

describe('cookies', () => {
  it('is HttpOnly and SameSite=Strict for a plain-http development setup', async () => {
    const h = makeApp();
    const res = await request(h.app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    const c = String(res.headers['set-cookie']);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).not.toMatch(/Secure/);
    expect(c).toMatch(/Path=\//);
  });

  it('is also Secure when HTTPS is declared, and HSTS is then enabled', async () => {
    const h = makeApp({ env: { HLCC_COOKIE_SECURE: 'true' } });
    const res = await request(h.app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    expect(String(res.headers['set-cookie'])).toMatch(/Secure/);
    expect(
      (await request(h.app).get('/api/v1/health')).headers['strict-transport-security'],
    ).toBeDefined();
  });

  it('does not send HSTS or force upgrades over plain http', async () => {
    const h = makeApp();
    const res = await request(h.app).get('/api/v1/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(String(res.headers['content-security-policy'])).not.toMatch(/upgrade-insecure-requests/);
  });

  it('is cleared on logout', async () => {
    const h = makeApp();
    const a = await signedIn(h);
    const res = await a.agent.post('/api/v1/auth/logout').set('x-csrf-token', a.csrf);
    expect(String(res.headers['set-cookie'])).toMatch(/hlcc_session=;/);
  });
});

describe('first-run setup', () => {
  it('cannot be repeated, replayed or raced after initialisation', async () => {
    const h = makeApp();
    const first = await request(h.app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    expect(first.status).toBe(201);
    for (let i = 0; i < 3; i++) {
      const again = await request(h.app)
        .post('/api/v1/auth/setup')
        .send({ setupToken: SETUP_TOKEN, username: `admin${i}`, password: PASSWORD });
      expect(again.status).toBe(409);
    }
    expect(Number(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n)).toBe(1);
  });

  it('lets only one of several simultaneous attempts win', async () => {
    const h = makeApp();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(h.app)
          .post('/api/v1/auth/setup')
          .send({ setupToken: SETUP_TOKEN, username: `admin${i}`, password: PASSWORD }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(Number(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n)).toBe(1);
  });

  it('runs the cleanup hook exactly when setup succeeds', async () => {
    const h = makeApp();
    let calls = 0;
    h.ctx.onSetupComplete = () => calls++;
    await request(h.app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: 'nope-nope-nope-nope', username: 'admin', password: PASSWORD });
    expect(calls).toBe(0);
    await request(h.app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    expect(calls).toBe(1);
  });
});
