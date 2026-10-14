import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ContainersBody, StateCell } from './Containers';
import { OverviewBody } from './Overview';
import { FreshnessBadge, HealthBadge, HttpCheckPill } from '../components/ui';
import { container, host, httpCheck, overview } from '../test-fixtures';

const renderOverview = (o = overview()) =>
  render(
    <MemoryRouter>
      <OverviewBody o={o} />
    </MemoryRouter>,
  );

describe('Overview', () => {
  it('shows measured values and marks demo data', () => {
    renderOverview();
    expect(screen.getByText('Demo data')).toBeInTheDocument();
    expect(screen.getByText('Reporting')).toBeInTheDocument();
    expect(screen.getByText('21.5%')).toBeInTheDocument();
    expect(screen.getByText(/1\.1 GiB \/ 7\.0 GiB/)).toBeInTheDocument();
    expect(screen.getByText('Simulated')).toBeInTheDocument();
  });

  it('warns that stale values are last-known, not current', () => {
    const o = overview();
    o.host.freshness = 'stale';
    renderOverview(o);
    expect(screen.getByText(/last known values, not current/i)).toBeInTheDocument();
    expect(screen.getByText('Reports stopped')).toBeInTheDocument();
    expect(screen.queryByText('Reporting')).not.toBeInTheDocument();
  });

  it('shows dashes, not zeros or healthy states, and the real error, when nothing was collected', () => {
    const o = overview({
      mode: 'live',
      host: { freshness: 'unavailable', collectedAt: null, source: 'live', data: null },
      docker: { freshness: 'unavailable', collectedAt: null, source: 'live', data: null },
      projects: [
        {
          id: 'demo',
          name: 'Demo',
          desiredState: 'running',
          health: { status: 'unknown', reason: 'No container data available' },
          httpCheck: 'not_configured',
        },
      ],
      collectorErrors: {
        host: {
          at: '2026-10-14T12:00:00Z',
          message: 'Host metrics refused: the Docker daemon runs in a VM',
        },
        docker: { at: '2026-10-14T12:00:00Z', message: 'Docker adapter not configured' },
        storage: null,
      },
    });
    renderOverview(o);
    expect(screen.getByText('Host metrics are unavailable')).toBeInTheDocument();
    expect(screen.getByText(/runs in a VM/)).toBeInTheDocument();
    expect(screen.getByText('Docker data is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument();
    expect(screen.getByText('No verified measurement method yet.')).toBeInTheDocument();
  });

  it('labels unbuilt sections as not available instead of faking data', () => {
    renderOverview();
    expect(screen.getAllByText('Not available yet')).toHaveLength(2);
  });

  it('never presents a folder on the root filesystem as the secondary disk', () => {
    const o = overview();
    o.host.data = {
      ...host,
      disks: [
        {
          mount: '/',
          status: 'ok',
          fsType: 'ext4',
          totalBytes: 458e9,
          usedBytes: 32e9,
          availableBytes: 400e9,
        },
        {
          mount: '/srv/storage',
          status: 'not_separate_mount',
          message:
            '/srv/storage is on the same filesystem as /; the secondary disk does not appear to be mounted',
        },
      ],
    };
    renderOverview(o);
    expect(screen.getByText('Not a separate mount')).toBeInTheDocument();
    expect(screen.getByText(/does not appear to be mounted/)).toBeInTheDocument();
    expect(screen.getByText('32.0 GB / 458.0 GB')).toBeInTheDocument();
    expect(screen.queryByText(/146/)).not.toBeInTheDocument();
  });

  it('says when an operator, not a cross-check, vouches for the host numbers', () => {
    const o = overview();
    o.host.data = { ...host, method: { kind: 'procfs', verification: 'operator-asserted' } };
    renderOverview(o);
    expect(screen.getByText(/operator asserts/)).toBeInTheDocument();
  });

  it('shows an unavailable CPU rate as a dash with the reason, not as 0%', () => {
    const o = overview();
    o.host.data = { ...host, cpuPercent: null };
    renderOverview(o);
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.getByText(/No CPU rate for this sample/)).toBeInTheDocument();
  });

  it('makes an operator-asserted reading visibly different from a verified one', () => {
    const verified = overview();
    verified.host.data = {
      ...host,
      method: { kind: 'procfs', verification: 'docker-info-cross-check' },
    };
    const { unmount } = renderOverview(verified);
    expect(screen.queryByText('Operator-asserted, not verified')).not.toBeInTheDocument();
    expect(screen.getByText(/cross-checked against the Docker daemon/)).toBeInTheDocument();
    unmount();

    const asserted = overview();
    asserted.host.data = { ...host, method: { kind: 'procfs', verification: 'operator-asserted' } };
    renderOverview(asserted);
    expect(screen.getByText('Operator-asserted, not verified')).toBeInTheDocument();
  });

  it('shows available space and the filesystem type, and a genuine zero as zero', () => {
    const o = overview();
    o.host.data = {
      ...host,
      disks: [
        {
          mount: '/srv/storage',
          status: 'ok',
          fsType: 'ext4',
          totalBytes: 146e9,
          usedBytes: 146e9,
          availableBytes: 0,
        },
      ],
    };
    renderOverview(o);
    expect(screen.getByText(/Available: 0 MB · ext4/)).toBeInTheDocument();
  });

  it('reports a storage problem without hiding the live readings', () => {
    const o = overview();
    o.collectorErrors.storage = {
      at: '2026-10-14T12:00:00Z',
      message: 'no such table: metric_samples',
    };
    renderOverview(o);
    expect(screen.getByText('Stored history has a problem')).toBeInTheDocument();
    expect(screen.getByText('Reporting')).toBeInTheDocument();
  });

  it('is honest about connectivity it cannot measure', () => {
    renderOverview();
    expect(screen.getByText('Needs host agent')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/No public health URL to test it/)).toBeInTheDocument();
  });

  it('shows Netdata as optional and off, or its values and errors when on', () => {
    renderOverview();
    expect(screen.getByText(/Netdata is optional and not configured/)).toBeInTheDocument();
  });

  it('shows Netdata readings with units, and its error', () => {
    const o = overview({
      netdata: {
        configured: true,
        error: 'Netdata requires authentication; this integration sends no credentials',
        freshness: 'unavailable',
        collectedAt: null,
        source: 'live',
        data: null,
      },
    });
    renderOverview(o);
    expect(screen.getByText(/sends no credentials/)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(3);
  });
});

describe('status components', () => {
  it('pairs every status with text, not colour alone', () => {
    render(
      <>
        <HealthBadge status="down" />
        <HealthBadge status="stopped" />
      </>,
    );
    expect(screen.getByText('Down')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('distinguishes current, stale and unavailable readings', () => {
    const now = new Date().toISOString();
    render(
      <>
        <FreshnessBadge freshness="current" collectedAt={now} />
        <FreshnessBadge freshness="stale" collectedAt={now} />
        <FreshnessBadge freshness="unavailable" collectedAt={null} />
      </>,
    );
    expect(screen.getByText(/^Current/)).toBeInTheDocument();
    expect(screen.getByText(/^Stale/)).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('shows an unconfigured HTTP check as "Not configured", never as OK', () => {
    render(<HttpCheckPill check={httpCheck()} />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.queryByText(/OK/)).not.toBeInTheDocument();
  });

  it('shows every HTTP check state distinctly', () => {
    const { rerender } = render(<HttpCheckPill check={httpCheck({ state: 'pending' })} />);
    expect(screen.getByText('Pending first check')).toBeInTheDocument();
    rerender(
      <HttpCheckPill check={httpCheck({ state: 'ok', latencyMs: 42, freshness: 'current' })} />,
    );
    expect(screen.getByText('OK · 42 ms')).toBeInTheDocument();
    rerender(
      <HttpCheckPill check={httpCheck({ state: 'ok', latencyMs: 42, freshness: 'stale' })} />,
    );
    expect(screen.getByText('OK · 42 ms (stale)')).toBeInTheDocument();
    rerender(<HttpCheckPill check={httpCheck({ state: 'failed', consecutiveFailures: 3 })} />);
    expect(screen.getByText('Failing (3)')).toBeInTheDocument();
    rerender(<HttpCheckPill check={httpCheck({ state: 'blocked' })} />);
    expect(screen.getByText('Blocked by policy')).toBeInTheDocument();
  });
});

describe('Containers', () => {
  it('does not call an intentional stop a failure', () => {
    render(<StateCell c={container({ stopIntent: 'intentional', exitCode: 0 })} />);
    expect(screen.getByText('Stopped (intentional)')).toBeInTheDocument();
  });

  it('flags only unexpected stops and unknown intent', () => {
    const { rerender } = render(<StateCell c={container({ stopIntent: 'unexpected' })} />);
    expect(screen.getByText('Stopped (unexpected)')).toBeInTheDocument();
    rerender(<StateCell c={container({ stopIntent: 'unknown' })} />);
    expect(screen.getByText('Stopped (intent unknown)')).toBeInTheDocument();
  });

  it('shows a running container whose health could not be read as unknown, not healthy', () => {
    render(
      <StateCell
        c={container({ state: 'running', health: 'unknown', exitCode: null, stopIntent: null })}
      />,
    );
    expect(screen.getByText('Running · health unknown')).toBeInTheDocument();
  });

  it('labels the memory limit as a cap and shows no usage for stopped containers', () => {
    render(
      <MemoryRouter>
        <ContainersBody
          data={{
            freshness: 'stale',
            collectedAt: '2026-10-14T11:00:00Z',
            source: 'mock',
            warnings: [],
            items: [container()],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/— \/ cap 256 MiB/)).toBeInTheDocument();
    expect(screen.getByText('Container data is stale')).toBeInTheDocument();
  });

  it('shows an unknown restart count as a dash and lists adapter warnings', () => {
    render(
      <MemoryRouter>
        <ContainersBody
          data={{
            freshness: 'current',
            collectedAt: new Date().toISOString(),
            source: 'live',
            warnings: ['web: inspect failed (proxy answered 500)'],
            items: [container({ restartCount: null })],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Some container details could not be read')).toBeInTheDocument();
    expect(screen.getByText(/inspect failed/)).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /auth-service/ });
    expect(row).toHaveTextContent(/—/);
    expect(row).not.toHaveTextContent('58');
  });
});
