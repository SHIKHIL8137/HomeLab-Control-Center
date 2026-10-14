import { Link } from 'react-router-dom';
import { Activity, Box, Cpu, HardDrive, MemoryStick, Network, Server } from 'lucide-react';
import type {
  ConnectivityState,
  DiskUsage,
  Freshness,
  HostMethod,
  Overview as OverviewData,
} from '@hlcc/shared';
import { useOverview } from '../hooks';
import { ApiRequestError } from '../lib/api';
import { formatBytes, formatDecimalBytes, formatDuration, percent, timeAgo } from '../lib/format';
import {
  Card,
  FreshnessBadge,
  HealthBadge,
  Meter,
  Notice,
  PageHeader,
  Pill,
  SourceBadge,
  Spinner,
  UnavailableNote,
  cx,
} from '../components/ui';

const hostState: Record<Freshness, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  current: { label: 'Reporting', tone: 'ok' },
  stale: { label: 'Reports stopped', tone: 'warn' },
  unavailable: { label: 'No data', tone: 'muted' },
};

const connectivityPill: Record<
  ConnectivityState,
  { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }
> = {
  ok: { label: 'OK', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  not_configured: { label: 'Not configured', tone: 'muted' },
  needs_host_agent: { label: 'Needs host agent', tone: 'muted' },
  unknown: { label: 'Unknown', tone: 'muted' },
};

const METHOD_TEXT: Record<HostMethod['verification'], string> = {
  'docker-info-cross-check': 'Measured from /proc and cross-checked against the Docker daemon',
  'operator-asserted':
    'Measured from /proc; the operator asserts it belongs to this machine (not cross-checked)',
  mock: 'Simulated',
};

export default function Overview() {
  const { data, error, isLoading } = useOverview();
  if (isLoading) return <Spinner />;
  if (error || !data) {
    return (
      <Notice tone="bad" title="Cannot load the overview">
        {error instanceof ApiRequestError ? error.message : 'The API did not respond.'}
      </Notice>
    );
  }
  return <OverviewBody o={data} />;
}

function DiskRow({ d }: { d: DiskUsage }) {
  if (d.status === 'ok') {
    return (
      <Meter
        label={d.mount}
        valueText={`${formatDecimalBytes(d.usedBytes)} / ${formatDecimalBytes(d.totalBytes)}`}
        fraction={d.usedBytes / d.totalBytes}
        detail={`Available: ${formatDecimalBytes(d.availableBytes)} · ${d.fsType}`}
      />
    );
  }
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{d.mount}</span>
        <Pill tone="warn">
          {d.status === 'not_separate_mount' ? 'Not a separate mount' : 'Unreadable'}
        </Pill>
      </div>
      <p className="mt-1 text-xs text-muted">{d.message}</p>
    </div>
  );
}

export function OverviewBody({ o }: { o: OverviewData }) {
  const host = o.host.data;
  const notCurrent = o.host.freshness !== 'current';
  const dim = notCurrent ? 'opacity-60' : '';
  const memUsedFraction = host ? host.memUsedBytes / host.memTotalBytes : null;
  const state = hostState[o.host.freshness];
  const { host: hostError, docker: dockerError, storage: storageError } = o.collectorErrors;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Measured state of the server, containers and registered projects."
        right={<SourceBadge source={o.mode} />}
      />

      {hostError && (
        <Notice tone="bad" title="Host metrics are unavailable">
          {hostError.message} (since {timeAgo(hostError.at)})
        </Notice>
      )}
      {storageError && (
        <Notice tone="bad" title="Stored history has a problem">
          {storageError.message} (since {timeAgo(storageError.at)}). Live readings may still be
          shown, but history may be incomplete.
        </Notice>
      )}
      {dockerError && (
        <Notice tone="bad" title="Docker data is unavailable">
          {dockerError.message} (since {timeAgo(dockerError.at)})
        </Notice>
      )}
      {o.host.freshness === 'stale' && (
        <Notice tone="warn" title="Showing last known values, not current ones">
          No new host data for a while. Figures below are dimmed and may be out of date.
        </Notice>
      )}
      {o.host.freshness === 'unavailable' && !hostError && (
        <Notice tone="warn" title="No host data yet">
          Nothing has been collected. Values are shown as “—” rather than guessed.
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card
          title="Host"
          icon={<Server className="h-4 w-4" />}
          right={<FreshnessBadge freshness={o.host.freshness} collectedAt={o.host.collectedAt} />}
        >
          <div className={cx('space-y-2 text-sm', dim)}>
            <p className="flex items-center justify-between">
              <span className="text-muted">Status</span>
              <Pill tone={state.tone}>{state.label}</Pill>
            </p>
            <p className="flex justify-between">
              <span className="text-muted">Uptime</span>
              <span>{host ? formatDuration(host.uptimeSeconds) : '—'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-muted">Last boot</span>
              <span>{host ? new Date(host.bootTime).toLocaleString() : '—'}</span>
            </p>
          </div>
          {host?.method.verification === 'operator-asserted' && (
            <p className="mt-3">
              <Pill tone="warn">Operator-asserted, not verified</Pill>
            </p>
          )}
          <p className="mt-3 text-xs text-muted">
            {host ? METHOD_TEXT[host.method.verification] : 'No verified measurement method yet.'}
          </p>
          <p className="mt-1 text-xs text-muted">
            This dashboard runs on the host, so it can show that reports stopped arriving but cannot
            prove the host is off.
          </p>
        </Card>

        <Card
          title="CPU"
          icon={<Cpu className="h-4 w-4" />}
          right={<FreshnessBadge freshness={o.host.freshness} collectedAt={o.host.collectedAt} />}
        >
          <div className={dim}>
            <Meter
              label="Utilisation"
              valueText={percent(host?.cpuPercent)}
              fraction={host && host.cpuPercent !== null ? host.cpuPercent / 100 : null}
              detail={
                host?.cpuPercent === null
                  ? 'No CPU rate for this sample (counters did not advance or were reset)'
                  : host?.load1 != null
                    ? `Load average (1 min): ${host.load1}`
                    : undefined
              }
            />
          </div>
        </Card>

        <Card
          title="Memory"
          icon={<MemoryStick className="h-4 w-4" />}
          right={<FreshnessBadge freshness={o.host.freshness} collectedAt={o.host.collectedAt} />}
        >
          <div className={cx('space-y-3', dim)}>
            <Meter
              label="Used (measured)"
              valueText={
                host
                  ? `${formatBytes(host.memUsedBytes)} / ${formatBytes(host.memTotalBytes)}`
                  : '—'
              }
              fraction={memUsedFraction}
              detail={host ? `Available: ${formatBytes(host.memAvailableBytes)}` : undefined}
            />
            <p className="flex justify-between text-sm">
              <span className="text-muted">Pressure (PSI avg60)</span>
              <span>{host?.memPressureAvg60 != null ? `${host.memPressureAvg60}%` : '—'}</span>
            </p>
            <p className="flex justify-between text-sm">
              <span className="text-muted">Swap used</span>
              <span>
                {host
                  ? `${formatBytes(host.swapUsedBytes)} / ${formatBytes(host.swapTotalBytes)}`
                  : '—'}
              </span>
            </p>
          </div>
        </Card>

        <Card
          title="Disks"
          icon={<HardDrive className="h-4 w-4" />}
          right={<FreshnessBadge freshness={o.host.freshness} collectedAt={o.host.collectedAt} />}
        >
          <div className={cx('space-y-3', dim)}>
            {!host && <p className="text-sm text-muted">—</p>}
            {host && host.disks.length === 0 && (
              <p className="text-sm text-muted">No disks configured (HLCC_DISKS).</p>
            )}
            {host?.disks.map((d) => (
              <DiskRow key={d.mount} d={d} />
            ))}
          </div>
        </Card>

        <Card
          title="Docker"
          icon={<Box className="h-4 w-4" />}
          right={
            <FreshnessBadge freshness={o.docker.freshness} collectedAt={o.docker.collectedAt} />
          }
        >
          {o.docker.data ? (
            <dl
              className={cx(
                'grid grid-cols-2 gap-3 text-sm',
                o.docker.freshness !== 'current' && 'opacity-60',
              )}
            >
              {(
                [
                  ['Running', o.docker.data.running],
                  ['Stopped', o.docker.data.stopped],
                  ['Unhealthy', o.docker.data.unhealthy],
                  ['Restarting', o.docker.data.restarting],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-xl font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted">No container data.</p>
          )}
          <p className="mt-2 text-xs text-muted">
            A stopped container is not necessarily a failure; see each project’s desired state.
          </p>
        </Card>

        <Card title="Connectivity" icon={<Network className="h-4 w-4" />}>
          <ul className="space-y-2 text-sm">
            {o.connectivity.map((c) => {
              const pill = connectivityPill[c.state];
              return (
                <li key={c.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted">{c.label}</span>
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{c.detail}</p>
                </li>
              );
            })}
          </ul>
        </Card>

        {o.netdata.configured && (
          <Card
            title="Network & disk I/O (Netdata)"
            icon={<Activity className="h-4 w-4" />}
            right={
              <FreshnessBadge freshness={o.netdata.freshness} collectedAt={o.netdata.collectedAt} />
            }
          >
            {o.netdata.error && <p className="mb-2 text-sm text-bad">{o.netdata.error}</p>}
            <dl
              className={cx(
                'grid grid-cols-2 gap-3 text-sm',
                o.netdata.freshness !== 'current' && 'opacity-60',
              )}
            >
              {(
                [
                  ['Network in', o.netdata.data?.netInKbps, 'kb/s'],
                  ['Network out', o.netdata.data?.netOutKbps, 'kb/s'],
                  ['Disk read', o.netdata.data?.diskReadKiBps, 'KiB/s'],
                  ['Disk write', o.netdata.data?.diskWriteKiBps, 'KiB/s'],
                ] as const
              ).map(([k, v, unit]) => (
                <div key={k}>
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-semibold tabular-nums">{v == null ? '—' : `${v} ${unit}`}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
        {!o.netdata.configured && (
          <Card title="Network & disk I/O (Netdata)" icon={<Activity className="h-4 w-4" />}>
            <p className="text-sm text-muted">
              Netdata is optional and not configured (HLCC_NETDATA_URL).
            </p>
          </Card>
        )}

        <Card title="Projects" className="md:col-span-2 xl:col-span-2">
          <ul className="divide-y divide-line">
            {o.projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link className="font-medium hover:underline" to={`/projects/${p.id}`}>
                  {p.name}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted">{p.health.reason}</span>
                  <HealthBadge status={p.health.status} />
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recent deployments">
          <UnavailableNote info={o.deployments} />
        </Card>
        <Card title="Recent alerts and incidents">
          <UnavailableNote info={o.alerts} />
        </Card>
      </div>
    </>
  );
}
