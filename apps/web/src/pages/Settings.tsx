import { useQueryClient } from '@tanstack/react-query';
import { useAuthStatus, useNetwork, useOverview } from '../hooks';
import { NetworkCard } from '../components/NetworkCard';
import { api } from '../lib/api';
import { Card, PageHeader, SourceBadge } from '../components/ui';

export default function Settings() {
  const { data: auth } = useAuthStatus();
  const { data: o } = useOverview();
  const { data: net } = useNetwork();
  const qc = useQueryClient();
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['auth'] });
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  };
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Session">
          <p className="text-sm">
            Signed in as <strong>{auth?.username}</strong>
          </p>
          <button
            onClick={() => void signOut()}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-raised"
          >
            Sign out
          </button>
        </Card>
        <Card title="Data source" right={o && <SourceBadge source={o.mode} />}>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Mode</dt>
              <dd>{o?.mode ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Collection interval</dt>
              <dd>{o ? `${o.pollIntervalMs / 1000} s` : '—'}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted">
            Mode and intervals are set by server environment variables (see .env.example), not from
            the browser.
          </p>
        </Card>
        {net && <NetworkCard n={net} />}
      </div>
    </>
  );
}
