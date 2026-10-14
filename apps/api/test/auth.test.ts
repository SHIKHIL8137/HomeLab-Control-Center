import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PASSWORD, SETUP_TOKEN, makeApp, signedIn } from './helpers.ts';

describe('authentication', () => {
  it('serves only the minimal health probe without a session', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/v1/health')).body).toEqual({ status: 'ok' });
    for (const path of [
      '/overview',
      '/projects',
      '/containers',
      '/audit',
      '/metrics/history',
      '/stream',
    ]) {
      expect((await request(app).get(`/api/v1${path}`)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/v1/projects').send({})).status).toBe(401);
  });

  it('requires the setup token, a long password, and works only once', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/v1/auth/status')).body.setupRequired).toBe(true);

    const bad = await request(app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: 'nope', username: 'admin', password: PASSWORD });
    expect(bad.status).toBe(403);
    const short = await request(app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: 'short' });
    expect(short.status).toBe(400);

    const ok = await request(app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    expect(ok.status).toBe(201);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const again = await request(app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'other', password: PASSWORD });
    expect(again.status).toBe(409);
    expect((await request(app).get('/api/v1/auth/status')).body.setupRequired).toBe(false);
  });

  it('marks the cookie Secure when configured', async () => {
    const { app } = makeApp({ env: { HLCC_COOKIE_SECURE: 'true' } });
    const ok = await request(app)
      .post('/api/v1/auth/setup')
      .send({ setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD });
    expect(String(ok.headers['set-cookie'])).toMatch(/Secure/);
  });

  it('rejects wrong credentials generically and rate-limits repeated failures', async () => {
    const h = makeApp();
    await signedIn(h);
    const attempt = (u: string, p: string) =>
      request(h.app).post('/api/v1/auth/login').send({ username: u, password: p });

    const wrongUser = await attempt('nobody', 'whatever-password');
    const wrongPass = await attempt('admin', 'whatever-password');
    expect(wrongUser.status).toBe(401);
    expect(wrongPass.body).toEqual(wrongUser.body);

    for (let i = 0; i < 3; i++) await attempt('admin', 'nope-nope-nope');
    const blocked = await attempt('admin', PASSWORD); // even the right password is refused while locked
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    h.time.t += 16 * 60_000;
    expect((await attempt('admin', PASSWORD)).status).toBe(200);
  });

  it('enforces CSRF tokens and same-origin on writes', async () => {
    const h = makeApp();
    const { agent, csrf } = await signedIn(h);
    const body = { id: 'demo', name: 'Demo' };

    expect((await agent.post('/api/v1/projects').send(body)).status).toBe(403);
    expect(
      (await agent.post('/api/v1/projects').set('x-csrf-token', 'wrong').send(body)).status,
    ).toBe(403);
    const evil = await agent
      .post('/api/v1/projects')
      .set('x-csrf-token', csrf)
      .set('Origin', 'https://evil.example')
      .send(body);
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('origin_not_allowed');
    expect((await agent.post('/api/v1/projects').set('x-csrf-token', csrf).send(body)).status).toBe(
      201,
    );
    expect((await agent.post('/api/v1/projects').set('x-csrf-token', csrf).send(body)).status).toBe(
      409,
    );
  });

  it('logs out by destroying the server-side session', async () => {
    const h = makeApp();
    const { agent, csrf } = await signedIn(h);
    expect((await agent.get('/api/v1/overview')).status).toBe(200);
    expect((await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrf)).status).toBe(200);
    expect((await agent.get('/api/v1/overview')).status).toBe(401);
  });

  it('expires sessions', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    h.time.t += h.ctx.cfg.sessionTtlMs + 1;
    expect((await agent.get('/api/v1/overview')).status).toBe(401);
  });
});

describe('audit trail', () => {
  it('records auth events without secrets and is readable only when signed in', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    await request(h.app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'wrong-password-123' });
    const res = await agent.get('/api/v1/audit');
    const actions = res.body.items.map(
      (e: { action: string; outcome: string }) => `${e.action}:${e.outcome}`,
    );
    expect(actions).toContain('auth.setup:success');
    expect(actions).toContain('auth.login:failure');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('wrong-password-123');
    expect(text).not.toContain(PASSWORD);
  });
});

describe('project registry', () => {
  it('only allows the monitor capability and validates input', async () => {
    const h = makeApp();
    const { agent, csrf } = await signedIn(h);
    const post = (b: object) => agent.post('/api/v1/projects').set('x-csrf-token', csrf).send(b);

    expect((await post({ id: 'x', name: 'X' })).status).toBe(400);
    expect((await post({ id: 'ok-id', name: 'X', capabilities: ['deploy'] })).body.error.code).toBe(
      'capability_not_enabled',
    );
    expect(
      (await post({ id: 'ok-id', name: 'X', repoUrl: 'https://user:pw@github.com/a/b' })).status,
    ).toBe(400);
    expect((await post({ id: 'ok-id', name: 'X', containers: ['a b'] })).status).toBe(400);
  });

  it('patches only submitted fields and refuses capability changes', async () => {
    const h = makeApp();
    const { agent, csrf } = await signedIn(h);
    const patch = (b: object) =>
      agent.patch('/api/v1/projects/devconnect').set('x-csrf-token', csrf).send(b);

    const res = await patch({ desiredState: 'stopped' });
    expect(res.status).toBe(200);
    expect(res.body.desiredState).toBe('stopped');
    expect(res.body.name).toBe('DevConnect');
    expect(res.body.containers.length).toBeGreaterThan(10); // not reset by schema defaults
    expect(res.body.repoUrl).toContain('DevConnect_BackEnd');

    expect((await patch({ capabilities: ['deploy'] })).body.error.code).toBe('field_not_editable');
    expect(
      (
        await agent
          .patch('/api/v1/projects/missing-one')
          .set('x-csrf-token', csrf)
          .send({ name: 'n' })
      ).status,
    ).toBe(404);
  });
});
