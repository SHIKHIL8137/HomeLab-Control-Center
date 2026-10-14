import type { Config } from '../config.ts';
import type { Clock } from '../db.ts';
import { createDockerAdapter } from './docker.ts';
import { createHostAdapter } from './host.ts';
import { createNetdataAdapter } from './netdata.ts';
import { ProviderUnavailableError, type Provider } from './types.ts';

/**
 * Real integrations. Anything not configured fails loudly with an explanation; there is no
 * fallback to demo data anywhere in this file.
 */
export function createLiveProvider(cfg: Config, clock: Clock): Provider {
  const docker = cfg.dockerUrl
    ? createDockerAdapter({ baseUrl: cfg.dockerUrl, token: cfg.dockerToken!, clock })
    : null;
  const host = createHostAdapter({
    clock,
    disks: cfg.disks,
    assertProcIsHost: cfg.hostProcAssert,
    ...(docker ? { daemon: () => docker.daemonInfo() } : {}),
  });
  return {
    source: 'live',
    host: () => host.read(),
    docker: docker
      ? () => docker.read()
      : () =>
          Promise.reject(
            new ProviderUnavailableError(
              'Docker adapter not configured (set HLCC_DOCKER_URL to the docker-proxy)',
            ),
          ),
    ...(cfg.netdataUrl ? { netdata: createNetdataAdapter({ baseUrl: cfg.netdataUrl }) } : {}),
  };
}
