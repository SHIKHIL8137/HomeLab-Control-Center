import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContainerView, ContainersResponse } from '@hlcc/shared';
import { useContainers } from '../hooks';
import { formatBytes, percent } from '../lib/format';
import {
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
    return (
      <Pill tone={c.health === 'unhealthy' ? 'bad' : 'ok'}>
        {c.health === 'unhealthy' ? 'Running · unhealthy' : 'Running'}
      </Pill>
    );
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

export default function Containers() {
  const { data, error, isLoading } = useContainers();
  if (isLoading) return <Spinner />;
  if (error || !data) return <Notice tone="bad" title="Cannot load containers" />;
  return <ContainersBody data={data} />;
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
          States below are the last known ones and may have changed.
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
                  <td className="px-3 py-2 tabular-nums">{c.restartCount}</td>
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
