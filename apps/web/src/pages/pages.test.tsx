import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ContainersBody, StateCell } from './Containers';
import { OverviewBody } from './Overview';
import { FreshnessBadge, HealthBadge } from '../components/ui';
import { container, overview } from '../test-fixtures';

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
  });

  it('warns that stale values are last-known, not current', () => {
    const o = overview();
    o.host.freshness = 'stale';
    renderOverview(o);
    expect(screen.getByText(/last known values, not current/i)).toBeInTheDocument();
    expect(screen.getByText('Reports stopped')).toBeInTheDocument();
    expect(screen.queryByText('Reporting')).not.toBeInTheDocument();
  });

  it('shows dashes, not zeros or healthy states, when nothing was collected', () => {
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
        },
      ],
      collectorError: {
        at: '2026-10-14T12:00:00Z',
        message: 'Live adapters are not implemented yet',
      },
    });
    renderOverview(o);
    expect(screen.getByText('No host data yet')).toBeInTheDocument();
    expect(screen.getByText('Data collection is failing')).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument();
  });

  it('labels unbuilt sections as not available instead of faking data', () => {
    renderOverview();
    expect(screen.getAllByText('Not available yet')).toHaveLength(2);
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
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

  it('labels the memory limit as a cap and shows no usage for stopped containers', () => {
    render(
      <MemoryRouter>
        <ContainersBody
          data={{
            freshness: 'stale',
            collectedAt: '2026-10-14T11:00:00Z',
            source: 'mock',
            items: [container()],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/— \/ cap 256 MiB/)).toBeInTheDocument();
    expect(screen.getByText('Container data is stale')).toBeInTheDocument();
  });
});
