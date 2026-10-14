import { Link } from 'react-router-dom';
import { Cpu, HardDrive, Box, Network, Server, MemoryStick } from 'lucide-react';
import type { Freshness, Overview as OverviewData } from '@hlcc/shared';
import { useOverview } from '../hooks';
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
import { ApiRequestError } from '../lib/api';

const hostState: Record<Freshness, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  current: { label: 'Reporting', tone: 'ok' },
  stale: { label: 'Reports stopped', tone: 'warn' },
  unavailable: { label: 'No data', tone: 'muted' },
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

export function OverviewBody({ o }: { o: OverviewData }) {
  const host = o.host.data;
  const notCurrent = o.host.freshness !== 'current';
  const dim = notCurrent ? 'opacity-60' : '';
  const memUsedFraction = host ? host.memUsedBytes / host.memTotalBytes : null;
  const state = hostState[o.host.freshness];

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Measured state of the server, containers and registered projects."
        right={<SourceBadge source={o.mode} />}
      />

      {o.collectorError && (
        <Notice tone="bad" title="Data collection is failing">
          {o.collectorError.message} (since {timeAgo(o.collectorError.at)})
        </Notice>
      )}
      {o.host.freshness === 'stale' && (
        <Notice tone="warn" title="Showing last known values, not current ones">
          No new host data for a while. Figures below are dimmed and may be out of date.
        </Notice>
      )}
      {o.host.freshness === 'unavailable' && (
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
          <p className="mt-3 text-xs text-muted">
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
              fraction={host ? host.cpuPercent / 100 : null}
              detail={host?.load1 != null ? `Load average (1 min): ${host.load1}` : undefined}
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
            {host?.disks.map((d) => (
              <Meter
                key={d.mount}
                label={d.mount}
                valueText={`${formatDecimalBytes(d.usedBytes)} / ${formatDecimalBytes(d.totalBytes)}`}
                fraction={d.usedBytes / d.totalBytes}
              />
            )) ?? <p className="text-sm text-muted">—</p>}
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
          <ul className="space-y-1.5 text-sm">
            {[
              'Network link / Wi-Fi',
              'Gateway',
              'DNS',
              'Internet',
              'Tailscale',
              'Cloudflare Tunnel',
            ].map((n) => (
              <li key={n} className="flex justify-between">
                <span className="text-muted">{n}</span>
                <Pill tone="muted">Not measured</Pill>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Reachability checks arrive with the Phase 3 adapters. A running container is not proof a
            tunnel works.
          </p>
        </Card>

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
