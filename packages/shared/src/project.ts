import { z } from 'zod';
import type { ContainerInfo } from './types.ts';

export const CAPABILITIES = ['monitor', 'deploy', 'restart', 'env'] as const;
export type Capability = (typeof CAPABILITIES)[number];

const containerName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);

export const projectInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  repoUrl: z
    .url()
    .refine(
      (u) => u.startsWith('https://') && !new URL(u).username,
      'https URL without credentials',
    )
    .nullable()
    .default(null),
  deploymentDir: z
    .string()
    .regex(/^\/[A-Za-z0-9_./-]*$/, 'absolute path')
    .refine((p) => !p.split('/').includes('..'), 'no parent segments')
    .nullable()
    .default(null),
  environment: z.enum(['production', 'staging', 'development']).default('production'),
  desiredState: z.enum(['running', 'stopped', 'unknown']).default('unknown'),
  healthUrl: z
    .url()
    .refine(
      (u) => /^https?:\/\//.test(u) && !new URL(u).username,
      'http(s) URL without credentials',
    )
    .nullable()
    .default(null),
  containers: z.array(containerName).max(40).default([]),
  capabilities: z.array(z.enum(CAPABILITIES)).default(['monitor']),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type Project = ProjectInput & { createdAt: string; updatedAt: string };

export type ProjectHealthStatus = 'healthy' | 'degraded' | 'down' | 'stopped' | 'unknown';
export interface ProjectHealth {
  status: ProjectHealthStatus;
  reason: string;
}

/**
 * Health from observed containers only. A stopped project is not a failure unless its desired
 * state says it should be running; with no data the answer is "unknown", never "healthy".
 */
export function deriveProjectHealth(
  project: Pick<ProjectInput, 'desiredState' | 'containers'>,
  snapshot: ContainerInfo[] | null,
): ProjectHealth {
  if (snapshot === null) return { status: 'unknown', reason: 'No container data available' };
  if (project.containers.length === 0) {
    return { status: 'unknown', reason: 'No containers registered' };
  }
  const found = project.containers
    .map((n) => snapshot.find((c) => c.name === n))
    .filter((c): c is ContainerInfo => c !== undefined);
  if (found.length === 0) {
    return { status: 'unknown', reason: 'Registered containers not found on host' };
  }

  const running = found.filter((c) => c.state === 'running');
  if (running.length === 0) {
    if (project.desiredState === 'stopped')
      return { status: 'stopped', reason: 'Stopped, as desired' };
    if (project.desiredState === 'running') {
      return { status: 'down', reason: 'Desired running, none running' };
    }
    return { status: 'stopped', reason: 'Stopped; desired state not set' };
  }
  const notReady = found.filter(
    (c) => c.state !== 'running' || c.health === 'unhealthy' || c.health === 'starting',
  );
  const missing = project.containers.length - found.length;
  if (notReady.length === 0 && missing === 0) {
    return { status: 'healthy', reason: 'All containers running' };
  }
  if (project.desiredState === 'stopped') {
    return { status: 'degraded', reason: 'Running although desired state is stopped' };
  }
  return {
    status: 'degraded',
    reason: `${notReady.length} not ready${missing ? `, ${missing} missing` : ''} of ${project.containers.length}`,
  };
}
