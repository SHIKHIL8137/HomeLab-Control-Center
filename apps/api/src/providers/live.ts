import { ProviderUnavailableError, type Provider } from './types.ts';

/**
 * Placeholder until the Phase 3 adapters (Docker, Netdata, host) exist. It fails loudly so that
 * live mode shows "unavailable" instead of quietly serving demo data.
 */
export function createLiveProvider(): Provider {
  const fail = () =>
    Promise.reject(
      new ProviderUnavailableError('Live adapters are not implemented yet (planned for Phase 3)'),
    );
  return { source: 'live', host: fail, containers: fail };
}
