import http from 'node:http';
import { z } from 'zod';
import type {
  ContainerEvent,
  ContainerHealth,
  ContainerInfo,
  ContainerState,
  DaemonInfo,
  DockerSnapshot,
} from '@hlcc/shared';
import type { Clock } from '../db.ts';
import { mapLimit } from '../util.ts';
import { ProviderUnavailableError } from './types.ts';

/**
 * Talks only to the read-only docker-proxy (apps/docker-proxy). It never sees the Docker socket,
 * never sends anything but GET, and every response is validated before use.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const EVENT_ACTIONS = ['start', 'stop', 'die', 'kill', 'oom', 'restart', 'health_status'];
const MAX_EVENT_WINDOW = 3500;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const infoSchema = z.object({
  MemTotal: z.number().optional(),
  NCPU: z.number().optional(),
  OperatingSystem: z.string().optional(),
  KernelVersion: z.string().optional(),
});
const listSchema = z.array(
  z.object({
    Id: z.string().min(1),
    Names: z.array(z.string()),
    Image: z.string(),
    State: z.enum(['running', 'exited', 'restarting', 'paused', 'created', 'dead', 'removing']),
    Created: z.number().optional(),
    Ports: z
      .array(
        z.object({
          IP: z.string().optional(),
          PrivatePort: z.number().optional(),
          PublicPort: z.number().optional(),
          Type: z.string().optional(),
        }),
      )
      .default([]),
  }),
);
const inspectSchema = z.object({
  RestartCount: z.number().optional(),
  State: z.object({
    ExitCode: z.number().optional(),
    StartedAt: z.string().optional(),
    Health: z.object({ Status: z.string().optional() }).optional(),
  }),
  HostConfig: z.object({ Memory: z.number().optional() }).default({}),
});
const statsSchema = z.object({
  cpu_stats: z.object({
    cpu_usage: z.object({ total_usage: z.number() }),
    system_cpu_usage: z.number().optional(),
    online_cpus: z.number().optional(),
  }),
  memory_stats: z.object({
    usage: z.number().optional(),
    stats: z
      .object({ inactive_file: z.number().optional(), total_inactive_file: z.number().optional() })
      .default({}),
  }),
});
const eventsSchema = z.array(
  z.object({
    Action: z.string(),
    time: z.number().optional(),
    timeNano: z.number().optional(),
    Actor: z
      .object({
        Attributes: z
          .object({ name: z.string().optional(), exitCode: z.string().optional() })
          .default({}),
      })
      .default({ Attributes: {} }),
  }),
);

class NotFound extends Error {}

export interface DockerAdapterOptions {
  /** e.g. http://docker-proxy:2375 */
  baseUrl: string;
  /** Shared secret presented to the proxy on every request. Never logged or returned. */
  token: string;
  clock: Clock;
  timeoutMs?: number;
  concurrency?: number;
}

export interface DockerAdapter {
  read(): Promise<DockerSnapshot>;
  /** Daemon facts, cached briefly; used to cross-check /proc. */
  daemonInfo(): Promise<DaemonInfo>;
}

function getJson<T>(
  base: URL,
  token: string,
  path: string,
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port || 80,
        path,
        method: 'GET',
        timeout: timeoutMs,
        agent: false,
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX_BYTES) {
            tooLarge = true;
            reject(new Error('response too large'));
            req.destroy();
            return;
          }
          chunks.push(d);
        });
        res.on('end', () => {
          if (tooLarge) return;
          if (res.statusCode === 401)
            return reject(new Error('the Docker proxy rejected the credential'));
          if (res.statusCode === 404) return reject(new NotFound());
          if (res.statusCode !== 200) return reject(new Error(`proxy answered ${res.statusCode}`));
          try {
            resolve(schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            reject(new Error('malformed response from the Docker proxy'));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Docker proxy timed out')));
    req.on('error', reject);
    req.end();
  });
}

const portText = (p: {
  IP?: string | undefined;
  PrivatePort?: number | undefined;
  PublicPort?: number | undefined;
  Type?: string | undefined;
}) => {
  const priv = `${p.PrivatePort ?? '?'}/${p.Type ?? 'tcp'}`;
  return p.PublicPort ? `${p.IP ? `${p.IP}:` : ''}${p.PublicPort}->${priv}` : priv;
};

const toHealth = (s: string | undefined): ContainerHealth =>
  s === undefined
    ? 'none'
    : s === 'healthy' || s === 'unhealthy' || s === 'starting'
      ? s
      : s === 'none'
        ? 'none'
        : 'unknown';

export function createDockerAdapter(opts: DockerAdapterOptions): DockerAdapter {
  const base = new URL(opts.baseUrl);
  if (base.protocol !== 'http:')
    throw new Error('HLCC_DOCKER_URL must be an http:// URL of the docker-proxy');
  const timeout = opts.timeoutMs ?? 5000;
  const limit = opts.concurrency ?? 4;
  const get = <T>(path: string, schema: z.ZodType<T>) =>
    getJson(base, opts.token, path, schema, timeout);

  const prevCpu = new Map<string, { total: number; system: number }>();
  let eventCursor: number | null = null;
  let daemonCache: { at: number; info: DaemonInfo } | null = null;

  const readDaemon = async (): Promise<DaemonInfo> => {
    const i = await get('/info', infoSchema);
    return {
      memTotalBytes: i.MemTotal ?? null,
      ncpu: i.NCPU ?? null,
      operatingSystem: i.OperatingSystem ?? null,
      kernelVersion: i.KernelVersion ?? null,
    };
  };

  return {
    async daemonInfo() {
      if (daemonCache && opts.clock() - daemonCache.at < 30_000) return daemonCache.info;
      try {
        const info = await readDaemon();
        daemonCache = { at: opts.clock(), info };
        return info;
      } catch (e) {
        throw new ProviderUnavailableError(`Docker daemon unreachable: ${(e as Error).message}`);
      }
    },

    async read() {
      const warnings: string[] = [];
      let daemon: DaemonInfo;
      let list: z.infer<typeof listSchema>;
      try {
        daemon = await readDaemon();
        daemonCache = { at: opts.clock(), info: daemon };
        list = await get('/containers/json?all=true', listSchema);
      } catch (e) {
        throw new ProviderUnavailableError(`Docker unavailable: ${(e as Error).message}`);
      }

      const seenRunning = new Set<string>();
      const built = await mapLimit(list, limit, async (c): Promise<ContainerInfo | null> => {
        const name = (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
        // The id goes into a request path, so a malformed one is never used.
        if (!SAFE_ID.test(c.Id)) {
          warnings.push(`${name.slice(0, 40)}: skipped, unexpected container id`);
          return null;
        }
        let health: ContainerHealth = 'unknown';
        let restartCount: number | null = null;
        let exitCode: number | null = null;
        let startedAt: string | null = null;
        let memLimit: number | null = null;
        try {
          const j = await get(`/containers/${c.Id}/json`, inspectSchema);
          health = toHealth(j.State.Health?.Status);
          restartCount = j.RestartCount ?? 0;
          exitCode = c.State === 'running' ? null : (j.State.ExitCode ?? null);
          startedAt =
            j.State.StartedAt && !j.State.StartedAt.startsWith('0001-') ? j.State.StartedAt : null;
          memLimit = j.HostConfig.Memory && j.HostConfig.Memory > 0 ? j.HostConfig.Memory : null;
        } catch (e) {
          if (e instanceof NotFound) return null; // removed between list and inspect
          warnings.push(`${name}: inspect failed (${(e as Error).message})`);
        }

        let cpuPercent: number | null = null;
        let memUsage: number | null = null;
        if (c.State === 'running') {
          seenRunning.add(c.Id);
          try {
            const s = await get(
              `/containers/${c.Id}/stats?stream=false&one-shot=true`,
              statsSchema,
            );
            const total = s.cpu_stats.cpu_usage.total_usage;
            const system = s.cpu_stats.system_cpu_usage;
            const prev = prevCpu.get(c.Id);
            if (system !== undefined) {
              if (prev && system > prev.system && total >= prev.total) {
                const cpus = s.cpu_stats.online_cpus ?? daemon.ncpu ?? 1;
                cpuPercent = Math.min(
                  cpus * 100,
                  Math.max(0, ((total - prev.total) / (system - prev.system)) * cpus * 100),
                );
                cpuPercent = Math.round(cpuPercent * 10) / 10;
              }
              prevCpu.set(c.Id, { total, system });
            }
            if (s.memory_stats.usage !== undefined) {
              const cache =
                s.memory_stats.stats.inactive_file ?? s.memory_stats.stats.total_inactive_file ?? 0;
              memUsage = Math.max(0, s.memory_stats.usage - cache);
            }
          } catch (e) {
            if (!(e instanceof NotFound))
              warnings.push(`${name}: stats failed (${(e as Error).message})`);
          }
        }

        return {
          id: c.Id,
          name,
          image: c.Image,
          state: c.State as ContainerState,
          health,
          restartCount,
          exitCode,
          createdAt: new Date((c.Created ?? 0) * 1000).toISOString(),
          startedAt,
          cpuPercent,
          memUsageBytes: memUsage,
          memLimitBytes: memLimit,
          ports: c.Ports.map(portText),
        };
      });
      for (const id of [...prevCpu.keys()]) if (!seenRunning.has(id)) prevCpu.delete(id);

      // Events are best-effort: Docker only replays a small recent buffer, so restart loops are
      // detected from RestartCount, not from this list.
      const events: ContainerEvent[] = [];
      const nowSec = Math.floor(opts.clock() / 1000);
      const until = nowSec - 2;
      let since = eventCursor ?? until - 60;
      if (until - since > MAX_EVENT_WINDOW) since = until - MAX_EVENT_WINDOW;
      if (since <= until) {
        try {
          const filters = encodeURIComponent(
            JSON.stringify({ type: ['container'], event: EVENT_ACTIONS }),
          );
          const raw = await get(
            `/events?since=${since}&until=${until}&filters=${filters}`,
            eventsSchema,
          );
          for (const e of raw) {
            const exit =
              e.Actor.Attributes.exitCode === undefined
                ? NaN
                : Number.parseInt(e.Actor.Attributes.exitCode, 10);
            events.push({
              ts:
                e.timeNano !== undefined ? Math.floor(e.timeNano / 1e6) : (e.time ?? until) * 1000,
              container: e.Actor.Attributes.name ?? 'unknown',
              action: e.Action,
              exitCode: Number.isFinite(exit) ? exit : null,
            });
          }
          eventCursor = until + 1;
        } catch (e) {
          warnings.push(`events unavailable (${(e as Error).message})`);
        }
      }

      return {
        containers: built.filter((c): c is ContainerInfo => c !== null),
        events,
        daemon,
        warnings,
      };
    },
  };
}
