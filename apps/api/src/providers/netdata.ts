import { z } from 'zod';
import type { NetdataExtras } from '@hlcc/shared';
import { guardedGet, type GuardedOptions } from '../security/ssrf.ts';
import { ProviderUnavailableError } from './types.ts';

/**
 * Optional, read-only Netdata integration for network and disk I/O rates.
 * It sends no credentials: if Netdata asks for authentication the integration reports that and
 * stays unavailable rather than being given a token. The response shape follows Netdata's
 * documented /api/v1/data JSON; it has been tested against fixtures, not against a live Netdata.
 */

const chartSchema = z.object({
  labels: z.array(z.string()),
  data: z.array(z.array(z.number().nullable())).min(1),
});

export interface NetdataOptions {
  baseUrl: string;
  resolver?: GuardedOptions['resolver'];
  timeoutMs?: number;
}

export function createNetdataAdapter(opts: NetdataOptions): () => Promise<NetdataExtras> {
  const base = new URL(opts.baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:')
    throw new Error('HLCC_NETDATA_URL must be http(s)');
  if (base.username || base.password)
    throw new Error('HLCC_NETDATA_URL must not contain credentials');

  const chart = async (name: string): Promise<Record<string, number> | null> => {
    const url = new URL('/api/v1/data', base);
    url.search = new URLSearchParams({
      chart: name,
      after: '-60',
      points: '1',
      group: 'average',
      format: 'json',
    }).toString();
    const r = await guardedGet(url.toString(), {
      allowPrivate: true, // Netdata normally lives on the LAN or a Docker bridge; link-local stays blocked
      timeoutMs: opts.timeoutMs ?? 2000,
      overallMs: (opts.timeoutMs ?? 2000) * 2,
      maxRedirects: 0,
      readBody: { maxBytes: 64 * 1024 },
      ...(opts.resolver ? { resolver: opts.resolver } : {}),
    });
    if (r.statusCode === 401 || r.statusCode === 403) {
      throw new ProviderUnavailableError(
        'Netdata requires authentication; this integration sends no credentials',
      );
    }
    if (r.statusCode === 404) return null; // chart not present on this Netdata
    if (!r.ok || r.body === undefined)
      throw new ProviderUnavailableError(
        `Netdata unavailable: ${r.message ?? `HTTP ${r.statusCode}`}`,
      );
    let parsed;
    try {
      parsed = chartSchema.parse(JSON.parse(r.body));
    } catch {
      throw new ProviderUnavailableError('Netdata returned an unexpected response');
    }
    const row = parsed.data[0]!;
    const out: Record<string, number> = {};
    parsed.labels.forEach((label, i) => {
      const v = row[i];
      if (label !== 'time' && v !== null && v !== undefined) out[label.toLowerCase()] = Math.abs(v);
    });
    return out;
  };

  const round = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);

  return async () => {
    const [net, io] = await Promise.all([chart('system.net'), chart('system.io')]);
    if (!net && !io)
      throw new ProviderUnavailableError('Netdata has no system.net or system.io chart');
    return {
      netInKbps: round(net?.received),
      netOutKbps: round(net?.sent),
      diskReadKiBps: round(io?.in),
      diskWriteKiBps: round(io?.out),
    };
  };
}
