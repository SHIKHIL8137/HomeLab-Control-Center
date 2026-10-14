import { describe, expect, it } from 'vitest';
import { createLiveProvider } from '../src/providers/live.ts';
import { signedIn, makeApp } from './helpers.ts';

const healthOf = (
  body: { projects: { id: string; health: { status: string; reason: string } }[] },
  id: string,
) => body.projects.find((p) => p.id === id)!.health;

describe('overview and staleness', () => {
  it('reports unavailable, never healthy, before any data was collected', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    const { body } = await agent.get('/api/v1/overview');
    expect(body.mode).toBe('mock');
    expect(body.host.freshness).toBe('unavailable');
    expect(body.host.data).toBeNull();
    expect(body.docker.freshness).toBe('unavailable');
    expect(
      body.projects.every((p: { health: { status: string } }) => p.health.status === 'unknown'),
    ).toBe(true);
  });

  it('is current after a collection, then stale once readings age past 2.5 intervals', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    await h.collector.collectOnce();

    let { body } = await agent.get('/api/v1/overview');
    expect(body.host.freshness).toBe('current');
    expect(body.host.source).toBe('mock');
    expect(body.host.data.memUsedBytes).toBeLessThan(2 * 1024 ** 3); // measured, not the sum of container caps
    expect(healthOf(body, 'devworkspace').status).toBe('healthy');

    h.time.t += 15_000 * 2.5 + 1;
    ({ body } = await agent.get('/api/v1/overview'));
    expect(body.host.freshness).toBe('stale');
    expect(body.docker.freshness).toBe('stale');
    expect(healthOf(body, 'devworkspace')).toEqual({
      status: 'unknown',
      reason: 'Container data is stale',
    });
  });

  it('shows live mode as unavailable instead of silently serving mock data', async () => {
    const h = makeApp({ provider: createLiveProvider() });
    const { agent } = await signedIn(h);
    await h.collector.collectOnce();

    const { body } = await agent.get('/api/v1/overview');
    expect(body.mode).toBe('live');
    expect(body.host.freshness).toBe('unavailable');
    expect(body.host.data).toBeNull();
    expect(body.collectorError.message).toMatch(/not implemented/i);
    expect((await agent.get('/api/v1/metrics/history')).body.points).toEqual([]);
  });

  it('keeps mock and live samples apart', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    await h.collector.collectOnce();
    h.time.t += 15_000;
    await h.collector.collectOnce();
    const res = await agent.get('/api/v1/metrics/history?minutes=5');
    expect(res.body.source).toBe('mock');
    expect(res.body.units).toEqual({ cpu: '%', memory: 'bytes' });
    expect(res.body.points).toHaveLength(2);

    const live = makeApp({ provider: createLiveProvider() });
    const s = await signedIn(live);
    expect((await s.agent.get('/api/v1/metrics/history')).body.points).toHaveLength(0);
  });

  it('validates query parameters', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    expect((await agent.get('/api/v1/metrics/history?minutes=0')).status).toBe(400);
    expect((await agent.get('/api/v1/audit?limit=9999')).status).toBe(400);
    expect((await agent.get('/api/v1/projects/NOT_VALID!')).status).toBe(400);
  });
});

describe('stopped is not the same as failed', () => {
  it('derives stop intent from the project desired state', async () => {
    const h = makeApp();
    const { agent, csrf } = await signedIn(h);
    await h.collector.collectOnce();
    const stopIntent = async () => {
      const { body } = await agent.get('/api/v1/containers');
      return body.items.find((c: { name: string }) => c.name === 'gateway-service').stopIntent;
    };
    const setDesired = (desiredState: string) =>
      agent.patch('/api/v1/projects/devconnect').set('x-csrf-token', csrf).send({ desiredState });

    expect(await stopIntent()).toBe('unknown');
    await setDesired('stopped');
    expect(await stopIntent()).toBe('intentional');
    expect(
      (await agent.get('/api/v1/overview')).body.projects.find(
        (p: { id: string }) => p.id === 'devconnect',
      ).health.status,
    ).toBe('stopped');
    await setDesired('running');
    expect(await stopIntent()).toBe('unexpected');
    expect(
      (await agent.get('/api/v1/overview')).body.projects.find(
        (p: { id: string }) => p.id === 'devconnect',
      ).health.status,
    ).toBe('down');
  });

  it('reports configured limits separately from measured usage', async () => {
    const h = makeApp();
    const { agent } = await signedIn(h);
    await h.collector.collectOnce();
    const { body } = await agent.get('/api/v1/containers');
    const auth = body.items.find((c: { name: string }) => c.name === 'auth-service');
    expect(auth.memLimitBytes).toBe(256 * 1024 ** 2);
    expect(auth.memUsageBytes).toBeNull(); // stopped: no usage, even though a cap is configured
    expect(auth.restartCount).toBe(58);
  });
});
