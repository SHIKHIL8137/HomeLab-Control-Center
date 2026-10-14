import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Project, ProjectView } from '@hlcc/shared';
import { useProject } from '../hooks';
import { api, ApiRequestError } from '../lib/api';
import { formatBytes, percent } from '../lib/format';
import {
  Card,
  FreshnessBadge,
  HealthBadge,
  HttpCheckPill,
  Notice,
  PageHeader,
  Spinner,
} from '../components/ui';
import { timeAgo } from '../lib/format';
import { StateCell } from './Containers';

/** Configure and inspect the HTTP check. The server validates the URL again on every request. */
export function HealthCheckCard({
  p,
  onChanged,
}: {
  p: ProjectView;
  onChanged: () => Promise<void>;
}) {
  const [url, setUrl] = useState(p.healthUrl ?? '');
  const [allowPrivate, setAllowPrivate] = useState(p.healthAllowPrivate);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const c = p.httpCheck;

  const save = async () => {
    setMsg(null);
    try {
      await api(`/projects/${p.id}`, {
        method: 'PATCH',
        body: {
          healthUrl: url.trim() === '' ? null : url.trim(),
          healthAllowPrivate: allowPrivate,
        },
      });
      await onChanged();
      setMsg({
        ok: true,
        text: url.trim() ? 'Saved. The first check runs now.' : 'Health check removed.',
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiRequestError ? e.message : 'Could not save' });
    }
  };

  return (
    <Card title="HTTP health check" right={<HttpCheckPill check={c} />}>
      {c.state !== 'not_configured' && (
        <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted">Last status</dt>
            <dd>{c.statusCode ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Latency</dt>
            <dd>{c.latencyMs === null ? '—' : `${c.latencyMs} ms`}</dd>
          </div>
          <div>
            <dt className="text-muted">Consecutive failures</dt>
            <dd>{c.consecutiveFailures}</dd>
          </div>
          <div>
            <dt className="text-muted">Target</dt>
            <dd>{c.targetClass ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Last success</dt>
            <dd>{timeAgo(c.lastSuccessAt)}</dd>
          </div>
          <div>
            <dt className="text-muted">Last failure</dt>
            <dd>{timeAgo(c.lastFailureAt)}</dd>
          </div>
          {c.error && (
            <div className="col-span-2">
              <dt className="text-muted">Last error</dt>
              <dd className="text-bad">{c.error}</dd>
            </div>
          )}
        </dl>
      )}
      <label htmlFor="healthUrl" className="mb-1 block text-sm font-medium">
        Health URL
      </label>
      <input
        id="healthUrl"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Not set. Leave empty for no check"
        className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
        autoComplete="off"
        spellCheck={false}
      />
      <p className="mt-1 text-xs text-muted">
        http or https, no credentials. Query strings may carry tokens, so avoid putting secrets in
        the URL.
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={allowPrivate}
          onChange={(e) => setAllowPrivate(e.target.checked)}
          className="mt-1"
        />
        <span>
          Allow a private address for this project (LAN, Tailscale, loopback)
          <span className="block text-xs text-muted">
            Off by default. Link-local and cloud-metadata addresses are never allowed, and a
            redirect can never move to another private host. Turning this on is recorded in the
            audit log.
          </span>
        </span>
      </label>
      <button
        onClick={() => void save()}
        className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent"
      >
        Save
      </button>
      {msg && (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={msg.ok ? 'mt-2 text-xs' : 'mt-2 text-xs text-bad'}
        >
          {msg.text}
        </p>
      )}
    </Card>
  );
}

export default function ProjectDetail() {
  const { id = '' } = useParams();
  const { data: p, error, isLoading } = useProject(id);
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);

  if (isLoading) return <Spinner />;
  if (error || !p) {
    return (
      <Notice
        tone="bad"
        title={
          error instanceof ApiRequestError && error.status === 404
            ? 'Project not found'
            : 'Cannot load the project'
        }
      >
        <Link className="underline" to="/projects">
          Back to projects
        </Link>
      </Notice>
    );
  }

  const setDesired = async (desiredState: Project['desiredState']) => {
    setMsg(null);
    try {
      await api(`/projects/${p.id}`, { method: 'PATCH', body: { desiredState } });
      await qc.invalidateQueries();
      setMsg('Desired state recorded. Nothing was started or stopped.');
    } catch (e) {
      setMsg(e instanceof ApiRequestError ? e.message : 'Could not update');
    }
  };

  return (
    <>
      <PageHeader
        title={p.name}
        subtitle={p.description}
        right={<HealthBadge status={p.health.status} />}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted">Health</dt>
              <dd>{p.health.reason}</dd>
            </div>
            <div>
              <dt className="text-muted">Environment</dt>
              <dd>{p.environment}</dd>
            </div>
            <div>
              <dt className="text-muted">Repository</dt>
              <dd>
                {p.repoUrl ? (
                  <a
                    className="break-all underline"
                    href={p.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {p.repoUrl}
                  </a>
                ) : (
                  'Not set'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Deployment directory</dt>
              <dd className="break-all font-mono text-xs">{p.deploymentDir ?? 'Not set'}</dd>
            </div>
            <div>
              <dt className="text-muted">HTTP health check</dt>
              <dd>
                <HttpCheckPill check={p.httpCheck} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Capabilities</dt>
              <dd>{p.capabilities.join(', ')}</dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-line pt-3">
            <label htmlFor="desired" className="mb-1 block text-sm font-medium">
              Desired state
            </label>
            <select
              id="desired"
              value={p.desiredState}
              onChange={(e) => void setDesired(e.target.value as Project['desiredState'])}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
            >
              <option value="running">running</option>
              <option value="stopped">stopped</option>
              <option value="unknown">unknown</option>
            </select>
            <p className="mt-1 text-xs text-muted">
              Records your intent so a stop is not shown as a failure. It does not start or stop
              anything.
            </p>
            {msg && (
              <p role="status" className="mt-2 text-xs">
                {msg}
              </p>
            )}
          </div>
        </Card>

        <Card
          title="Containers"
          className="lg:col-span-2"
          right={<FreshnessBadge freshness={p.freshness} collectedAt={null} />}
        >
          {p.containersObserved.length === 0 ? (
            <p className="text-sm text-muted">
              {p.containers.length
                ? 'None of the registered containers were found on the host.'
                : 'No containers registered.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <caption className="sr-only">Containers of {p.name}</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    {['Name', 'State', 'CPU', 'Memory'].map((h) => (
                      <th key={h} scope="col" className="py-1 pr-3 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.containersObserved.map((c) => (
                    <tr key={c.id}>
                      <th scope="row" className="py-2 pr-3 font-medium">
                        {c.name}
                      </th>
                      <td className="py-2 pr-3">
                        <StateCell c={c} />
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{percent(c.cpuPercent)}</td>
                      <td className="py-2 pr-3 tabular-nums">{formatBytes(c.memUsageBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="lg:col-span-3">
          <HealthCheckCard
            key={`${p.healthUrl}|${p.healthAllowPrivate}`}
            p={p}
            onChanged={() => qc.invalidateQueries()}
          />
        </div>
      </div>
    </>
  );
}
