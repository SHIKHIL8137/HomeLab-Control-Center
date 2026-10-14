import type {
  DataSource,
  DaemonInfo,
  DockerSnapshot,
  HostSample,
  NetdataExtras,
} from '@hlcc/shared';

/**
 * Each integration is independent: one failing must not blank the others. A provider method that
 * cannot produce a trustworthy value rejects with ProviderUnavailableError instead of guessing.
 */
export interface Provider {
  source: DataSource;
  host(): Promise<HostSample>;
  docker(): Promise<DockerSnapshot>;
  /** Present only when the optional Netdata integration is configured. */
  netdata?: () => Promise<NetdataExtras>;
}

export class ProviderUnavailableError extends Error {}

export type { DaemonInfo };
