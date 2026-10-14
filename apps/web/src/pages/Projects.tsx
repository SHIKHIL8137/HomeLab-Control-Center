import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { projectInputSchema } from '@hlcc/shared';
import { useProjects } from '../hooks';
import { api, ApiRequestError } from '../lib/api';
import {
  Card,
  FreshnessBadge,
  HealthBadge,
  HttpCheckPill,
  Notice,
  PageHeader,
  Spinner,
} from '../components/ui';

interface FormValues {
  id: string;
  name: string;
  description: string;
  repoUrl: string;
  deploymentDir: string;
  containers: string;
}

function AddProject({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>();

  const onSubmit = handleSubmit(async (v) => {
    setServerError(null);
    // Validate with the same schema the API uses, so messages match.
    const parsed = projectInputSchema.safeParse({
      id: v.id,
      name: v.name,
      description: v.description,
      repoUrl: v.repoUrl.trim() || null,
      deploymentDir: v.deploymentDir.trim() || null,
      containers: v.containers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const field = String(i.path[0]) as keyof FormValues;
        if (field in v) setError(field, { message: i.message });
      }
      return;
    }
    try {
      await api('/projects', { method: 'POST', body: parsed.data });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      onDone();
    } catch (e) {
      setServerError(e instanceof ApiRequestError ? e.message : 'Could not create the project');
    }
  });

  const field = (name: keyof FormValues, label: string, hint?: string) => (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
        aria-invalid={Boolean(errors[name])}
        {...register(name)}
      />
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {errors[name] && (
        <p role="alert" className="mt-1 text-xs text-bad">
          {errors[name]?.message}
        </p>
      )}
    </div>
  );

  return (
    <Card title="Register a project" className="mb-4">
      <form
        onSubmit={onSubmit}
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        aria-label="Register a project"
      >
        {field('id', 'ID', 'Lowercase letters, digits and dashes')}
        {field('name', 'Name')}
        {field('repoUrl', 'Repository URL (optional)', 'https only, no embedded credentials')}
        {field(
          'deploymentDir',
          'Deployment directory (optional)',
          'Absolute path; only recorded, never touched',
        )}
        <div className="sm:col-span-2">
          {field(
            'containers',
            'Container names (comma separated)',
            'Must match names Docker reports',
          )}
        </div>
        <div className="sm:col-span-2">{field('description', 'Description')}</div>
        {serverError && (
          <p role="alert" className="text-sm text-bad sm:col-span-2">
            {serverError}
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
          >
            Register
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded-lg border border-line px-3 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
      <p className="mt-3 text-xs text-muted">
        Registered projects are monitor-only. Deploy, restart and environment capabilities are not
        available in this release.
      </p>
    </Card>
  );
}

export default function Projects() {
  const { data, error, isLoading } = useProjects();
  const [adding, setAdding] = useState(false);
  if (isLoading) return <Spinner />;
  if (error || !data) return <Notice tone="bad" title="Cannot load projects" />;
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Registered projects and their observed health."
        right={
          !adding && (
            <button
              onClick={() => setAdding(true)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-raised"
            >
              Register project
            </button>
          )
        }
      />
      {adding && <AddProject onDone={() => setAdding(false)} />}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((p) => (
          <Card
            key={p.id}
            title={p.environment}
            right={<FreshnessBadge freshness={p.freshness} collectedAt={null} />}
          >
            <div className="flex items-start justify-between gap-2">
              <Link to={`/projects/${p.id}`} className="text-lg font-semibold hover:underline">
                {p.name}
              </Link>
              <HealthBadge status={p.health.status} />
            </div>
            <p className="mt-1 text-sm text-muted">{p.description || 'No description'}</p>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Desired</dt>
                <dd>{p.desiredState}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Observed</dt>
                <dd>{p.health.reason}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Containers</dt>
                <dd>
                  {p.containersObserved.length}/{p.containers.length} found
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">HTTP check</dt>
                <dd>
                  <HttpCheckPill check={p.httpCheck} />
                </dd>
              </div>
            </dl>
          </Card>
        ))}
      </div>
    </>
  );
}
