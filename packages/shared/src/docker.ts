import type { ContainerInfo, DockerSummary } from './types.ts';

export function summarizeContainers(containers: ContainerInfo[]): DockerSummary {
  return {
    daemonUp: true,
    total: containers.length,
    running: containers.filter((c) => c.state === 'running').length,
    stopped: containers.filter((c) => ['exited', 'created', 'dead'].includes(c.state)).length,
    unhealthy: containers.filter((c) => c.health === 'unhealthy').length,
    restarting: containers.filter((c) => c.state === 'restarting').length,
  };
}
