import { describe, expect, it } from 'vitest';
import { deriveProjectHealth, projectInputSchema } from './project.ts';
import { freshness } from './freshness.ts';
import type { ContainerInfo } from './types.ts';

const c = (name: string, over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  id: name,
  name,
  image: 'x',
  state: 'running',
  health: 'none',
  restartCount: 0,
  exitCode: null,
  createdAt: '2026-01-01T00:00:00Z',
  startedAt: null,
  cpuPercent: null,
  memUsageBytes: null,
  memLimitBytes: null,
  ports: [],
  ...over,
});

describe('freshness', () => {
  it('is unavailable without a reading, current within 2.5 intervals, stale after', () => {
    expect(freshness(null, 1000, 100)).toBe('unavailable');
    expect(freshness(1000, 1250, 100)).toBe('current');
    expect(freshness(1000, 1251, 100)).toBe('stale');
  });
});

describe('deriveProjectHealth', () => {
  const p = { desiredState: 'running' as const, containers: ['a', 'b'] };

  it('never reports healthy without data', () => {
    expect(deriveProjectHealth(p, null).status).toBe('unknown');
    expect(deriveProjectHealth({ ...p, containers: [] }, []).status).toBe('unknown');
    expect(deriveProjectHealth(p, []).status).toBe('unknown');
  });

  it('is healthy only when every registered container is running and not unhealthy', () => {
    expect(deriveProjectHealth(p, [c('a'), c('b', { health: 'healthy' })]).status).toBe('healthy');
    expect(deriveProjectHealth(p, [c('a'), c('b', { health: 'unhealthy' })]).status).toBe(
      'degraded',
    );
    expect(deriveProjectHealth(p, [c('a')]).status).toBe('degraded');
  });

  it('treats an intentional stop as stopped, not down', () => {
    const stopped = [c('a', { state: 'exited' }), c('b', { state: 'exited' })];
    expect(deriveProjectHealth({ ...p, desiredState: 'stopped' }, stopped).status).toBe('stopped');
    expect(deriveProjectHealth(p, stopped).status).toBe('down');
    expect(deriveProjectHealth({ ...p, desiredState: 'unknown' }, stopped).status).toBe('stopped');
  });
});

describe('projectInputSchema', () => {
  it('rejects credentials in URLs, traversal paths and bad container names', () => {
    const base = { id: 'demo', name: 'Demo' };
    expect(projectInputSchema.safeParse(base).success).toBe(true);
    expect(
      projectInputSchema.safeParse({ ...base, repoUrl: 'https://u:p@github.com/a/b' }).success,
    ).toBe(false);
    expect(projectInputSchema.safeParse({ ...base, deploymentDir: '/srv/../etc' }).success).toBe(
      false,
    );
    expect(projectInputSchema.safeParse({ ...base, containers: ['a; rm -rf /'] }).success).toBe(
      false,
    );
    expect(projectInputSchema.parse(base).capabilities).toEqual(['monitor']);
  });
});
