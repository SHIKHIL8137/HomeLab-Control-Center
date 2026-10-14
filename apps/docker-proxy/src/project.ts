import { ALLOWED_EVENTS } from './policy.ts';

/**
 * Responses are rebuilt from an allowlist of fields, never forwarded. Docker's inspect output
 * contains Config.Env, Cmd and healthcheck logs, all of which can hold secrets; none of them
 * ever leave this process.
 */
type Json = Record<string, unknown>;

const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Only the compose grouping labels are kept; arbitrary labels can carry anything. */
function labels(v: unknown): Json {
  const l = obj(v);
  const out: Json = {};
  for (const k of ['com.docker.compose.project', 'com.docker.compose.service']) {
    const s = str(l[k]);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

export function projectInfo(raw: unknown): Json {
  const i = obj(raw);
  return {
    MemTotal: num(i.MemTotal),
    NCPU: num(i.NCPU),
    OperatingSystem: str(i.OperatingSystem),
    KernelVersion: str(i.KernelVersion),
    ServerVersion: str(i.ServerVersion),
  };
}

export function projectList(raw: unknown): Json[] {
  return arr(raw).map((c) => {
    const x = obj(c);
    return {
      Id: str(x.Id),
      Names: arr(x.Names).filter((n): n is string => typeof n === 'string'),
      Image: str(x.Image),
      State: str(x.State),
      Status: str(x.Status),
      Created: num(x.Created),
      Ports: arr(x.Ports).map((p) => {
        const q = obj(p);
        return {
          IP: str(q.IP),
          PrivatePort: num(q.PrivatePort),
          PublicPort: num(q.PublicPort),
          Type: str(q.Type),
        };
      }),
      Labels: labels(x.Labels),
    };
  });
}

export function projectInspect(raw: unknown): Json {
  const j = obj(raw);
  const state = obj(j.State);
  const health = obj(state.Health);
  const host = obj(j.HostConfig);
  const restart = obj(host.RestartPolicy);
  return {
    Id: str(j.Id),
    Name: str(j.Name),
    Created: str(j.Created),
    Image: str(obj(j.Config).Image),
    RestartCount: num(j.RestartCount),
    State: {
      Status: str(state.Status),
      Running: bool(state.Running),
      Restarting: bool(state.Restarting),
      OOMKilled: bool(state.OOMKilled),
      ExitCode: num(state.ExitCode),
      StartedAt: str(state.StartedAt),
      FinishedAt: str(state.FinishedAt),
      Health: state.Health
        ? { Status: str(health.Status), FailingStreak: num(health.FailingStreak) }
        : undefined,
    },
    HostConfig: {
      Memory: num(host.Memory),
      RestartPolicy: { Name: str(restart.Name), MaximumRetryCount: num(restart.MaximumRetryCount) },
    },
    Labels: labels(obj(j.Config).Labels),
  };
}

export function projectStats(raw: unknown): Json {
  const s = obj(raw);
  const cpu = obj(s.cpu_stats);
  const mem = obj(s.memory_stats);
  const memStats = obj(mem.stats);
  return {
    read: str(s.read),
    cpu_stats: {
      cpu_usage: { total_usage: num(obj(cpu.cpu_usage).total_usage) },
      system_cpu_usage: num(cpu.system_cpu_usage),
      online_cpus: num(cpu.online_cpus),
    },
    memory_stats: {
      usage: num(mem.usage),
      limit: num(mem.limit),
      stats: {
        inactive_file: num(memStats.inactive_file),
        total_inactive_file: num(memStats.total_inactive_file),
      },
    },
  };
}

/** Events arrive as JSON lines. The action is normalised ("health_status: healthy" becomes "health_status"). */
export function projectEvents(rawLines: string, maxLines = 2000): Json[] {
  const out: Json[] = [];
  for (const line of rawLines.split('\n')) {
    if (!line.trim()) continue;
    if (out.length >= maxLines) break;
    let e: Json;
    try {
      e = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const attrs = obj(obj(e.Actor).Attributes);
    const action = (str(e.Action) ?? '').split(':')[0]!.trim();
    // Second line of defence: exec_* actions embed full command lines and are never passed on.
    if (!(ALLOWED_EVENTS as readonly string[]).includes(action)) continue;
    out.push({
      Action: action,
      time: num(e.time),
      timeNano: num(e.timeNano),
      Actor: {
        Attributes: {
          name: str(attrs.name),
          image: str(attrs.image),
          exitCode: str(attrs.exitCode),
          signal: str(attrs.signal),
        },
      },
    });
  }
  return out;
}
