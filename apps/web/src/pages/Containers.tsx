import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContainerView, ContainersResponse } from '@hlcc/shared';
import { useContainers, useEvents } from '../hooks';
import { formatBytes, percent } from '../lib/format';
import {
  Card,
  EmptyState,
  FreshnessBadge,
  Notice,
  PageHeader,
  Pill,
  SourceBadge,
  Spinner,
} from '../components/ui';

export function StateCell({ c }: { c: ContainerView }) {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return <Pill tone="bad">Running · unhealthy</Pill>;
    if (c.health === 'unknown') return <Pill tone="warn">Running · health unknown</Pill>;
    return <Pill tone="ok">Running</Pill>;
  }
  if (c.state === 'restarting') return <Pill tone="bad">Restarting</Pill>;
  const intent = {
    intentional: <Pill tone="muted">Stopped (intentional)</Pill>,
    unexpected: <Pill tone="bad">Stopped (unexpected)</Pill>,
    unknown: <Pill tone="warn">Stopped (intent unknown)</Pill>,
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {intent[c.stopIntent ?? 'unknown']}
      {c.exitCode !== null && <span className="text-xs text-muted">exit {c.exitCode}</span>}
    </span>
  );
}

function RecentEvents() {
  const { data, error } = useEvents();
  return (
    <Card title="Recent container events" className="mt-4">
      {error && <p className="text-sm text-muted">Events are unavailable right now.</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted">No events recorded.</p>}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {data.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                <span className="font-medium">{e.container}</span>{' '}
                <span className="text-muted">{e.action}</span>
              </span>
              <span className="text-xs text-muted">
                {e.exitCode !== null && `exit ${e.exitCode} · `}
                {new Date(e.ts).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && <p className="mt-2 text-xs text-muted">{data.note}</p>}
    </Card>
  );
}

export default function Containers() {
  const { data, error, isLoading } = useContainers();
  if (isLoading) return <Spinner />;
  if (error || !data) return <Notice tone="bad" title="Cannot load containers" />;
  return (
    <>
      <ContainersBody data={data} />
      <RecentEvents />
    </>
  );
}

export function ContainersBody({ data }: { data: ContainersResponse }) {
  const [q, setQ] = useState('');
  const items = data.items.filter((c) =>
    `${c.name} ${c.image} ${c.projectId ?? ''}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title="Containers"
        subtitle="Observed state. Memory limits are configured caps, not consumption."
        right={
          <span className="flex gap-2">
            <SourceBadge source={data.source} />
            <FreshnessBadge freshness={data.freshness} collectedAt={data.collectedAt} />
          </span>
        }
      />
      {data.freshness !== 'current' && (
        <Notice
          tone="warn"
          title={data.freshness === 'stale' ? 'Container data is stale' : 'No container data'}
        >
          {data.freshness === 'stale'
            ? 'States below are the last known ones and may have changed.'
            : 'Nothing has been collected from Docker yet.'}
        </Notice>
      )}
      {data.warnings.length > 0 && (
        <Notice tone="warn" title="Some container details could not be read">
          <ul className="list-disc pl-5">
            {data.warnings.slice(0, 5).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      <label className="sr-only" htmlFor="filter">
        Filter containers
      </label>
      <input
        id="filter"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter by name, image or project"
        className="mb-3 w-full max-w-sm rounded-lg border border-line bg-surface px-3 py-2 text-sm"
      />
      {items.length === 0 ? (
        <EmptyState title="No containers to show">
          {data.items.length
            ? 'Nothing matches the filter.'
            : 'The collector has not reported any containers.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">Containers</caption>
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                {[
                  'Name',
                  'Project',
                  'Image',
                  'State',
                  'Restarts',
                  'CPU',
                  'Memory (used / cap)',
                  'Ports',
                ].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((c) => (
                <tr key={c.id}>
                  <th scope="row" className="px-3 py-2 font-medium">
                    {c.name}
                  </th>
                  <td className="px-3 py-2">
                    {c.projectId ? (
                      <Link className="hover:underline" to={`/projects/${c.projectId}`}>
                        {c.projectId}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{c.image}</td>
                  <td className="px-3 py-2">
                    <StateCell c={c} />
                  </td>
                  <td className="px-3 py-2 tabular-nums">{c.restartCount ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{percent(c.cpuPercent)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatBytes(c.memUsageBytes)} /{' '}
                    {c.memLimitBytes ? `cap ${formatBytes(c.memLimitBytes, 0)}` : 'no cap'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{c.ports.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
