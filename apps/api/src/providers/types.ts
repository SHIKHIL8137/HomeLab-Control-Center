import type { ContainerInfo, DataSource, HostSample } from '@hlcc/shared';

export interface Provider {
  source: DataSource;
  host(): Promise<HostSample>;
  containers(): Promise<ContainerInfo[]>;
}

export class ProviderUnavailableError extends Error {}
