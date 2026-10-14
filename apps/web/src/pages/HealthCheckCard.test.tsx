import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@hlcc/shared';
import { HealthCheckCard } from './ProjectDetail';
import { httpCheck } from '../test-fixtures';

const project = (over: Partial<ProjectView> = {}): ProjectView => ({
  id: 'nextcloud',
  name: 'Nextcloud',
  description: '',
  repoUrl: null,
  deploymentDir: null,
  environment: 'production',
  desiredState: 'running',
  healthUrl: null,
  healthAllowPrivate: false,
  containers: [],
  capabilities: ['monitor'],
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
  health: { status: 'unknown', reason: 'x' },
  containersObserved: [],
  freshness: 'current',
  httpCheck: httpCheck(),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('HealthCheckCard', () => {
  it('starts unset: no URL is invented and the check reads "Not configured"', () => {
    render(<HealthCheckCard p={project()} onChanged={async () => {}} />);
    expect(screen.getByLabelText('Health URL')).toHaveValue('');
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('explains what private access allows and what is never allowed', () => {
    render(<HealthCheckCard p={project()} onChanged={async () => {}} />);
    expect(screen.getByText(/metadata addresses are never allowed/i)).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit log/i)).toBeInTheDocument();
  });

  it('sends the trimmed URL and the private-access choice, then reports success', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const changed = vi.fn(async () => {});
    render(<HealthCheckCard p={project()} onChanged={changed} />);
    await userEvent.type(
      screen.getByLabelText('Health URL'),
      '  http://192.168.1.113:8080/status.php ',
    );
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(String(path)).toBe('/api/v1/projects/nextcloud');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      healthUrl: 'http://192.168.1.113:8080/status.php',
      healthAllowPrivate: true,
    });
    expect(changed).toHaveBeenCalled();
  });

  it('removes the check when the field is emptied', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    render(
      <HealthCheckCard
        p={project({
          healthUrl: 'https://example.com/',
          httpCheck: httpCheck({ state: 'ok', latencyMs: 5, freshness: 'current' }),
        })}
        onChanged={async () => {}}
      />,
    );
    await userEvent.clear(screen.getByLabelText('Health URL'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('removed'));
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).healthUrl,
    ).toBeNull();
  });

  it("shows the server's rejection of a forbidden target", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'health_target_rejected',
            message: 'That address range is never allowed (link-local, metadata, reserved)',
          },
        }),
        { status: 400 },
      ),
    );
    render(<HealthCheckCard p={project()} onChanged={async () => {}} />);
    await userEvent.type(screen.getByLabelText('Health URL'), 'http://169.254.169.254/');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('never allowed'));
  });

  it('shows the details of a failing check, including the error and failure count', () => {
    render(
      <HealthCheckCard
        p={project({
          healthUrl: 'https://example.com/',
          httpCheck: httpCheck({
            state: 'failed',
            statusCode: 503,
            latencyMs: 30,
            consecutiveFailures: 3,
            error: 'HTTP 503',
            targetClass: 'public',
            freshness: 'current',
            lastFailureAt: new Date().toISOString(),
          }),
        })}
        onChanged={async () => {}}
      />,
    );
    expect(screen.getByText('Failing (3)')).toBeInTheDocument();
    expect(screen.getByText('503')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
    expect(screen.getByText('public')).toBeInTheDocument();
  });
});
