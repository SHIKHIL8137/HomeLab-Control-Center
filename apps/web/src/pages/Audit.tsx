import { useAudit } from '../hooks';
import { EmptyState, Notice, PageHeader, Pill, Spinner } from '../components/ui';

export default function Audit() {
  const q = useAudit();
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Notice tone="bad" title="Cannot load the audit history" />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Audit History"
        subtitle="Sign-ins, setup and registry changes. Secret values are never recorded."
      />
      {items.length === 0 ? (
        <EmptyState title="No audit events yet" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Audit events, newest first</caption>
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                {['Time', 'Actor', 'Action', 'Target', 'Outcome', 'IP'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2">{new Date(e.ts).toLocaleString()}</td>
                  <td className="px-3 py-2">{e.actor}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-3 py-2">{e.target ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Pill
                      tone={
                        e.outcome === 'success' ? 'ok' : e.outcome === 'denied' ? 'warn' : 'bad'
                      }
                    >
                      {e.outcome}
                    </Pill>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <button
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-raised"
        >
          {q.isFetchingNextPage ? 'Loading…' : 'Load older events'}
        </button>
      )}
    </>
  );
}
