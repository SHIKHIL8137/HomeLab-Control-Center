import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  CircleSlash,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import type { DataSource, Freshness, NotAvailable, ProjectHealthStatus } from '@hlcc/shared';
import { useNow } from '../hooks';
import { timeAgo } from '../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Card({
  title,
  icon,
  right,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface p-4', className)}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted">
          {icon}
          {title}
        </h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

const HEALTH = {
  healthy: { label: 'Healthy', cls: 'text-ok border-ok/40 bg-ok/10', Icon: CheckCircle2 },
  degraded: { label: 'Degraded', cls: 'text-warn border-warn/40 bg-warn/10', Icon: AlertTriangle },
  down: { label: 'Down', cls: 'text-bad border-bad/40 bg-bad/10', Icon: XCircle },
  stopped: { label: 'Stopped', cls: 'text-muted border-line bg-raised', Icon: PauseCircle },
  unknown: { label: 'Unknown', cls: 'text-muted border-line bg-raised', Icon: CircleHelp },
} satisfies Record<ProjectHealthStatus, { label: string; cls: string; Icon: typeof XCircle }>;

/** Status is always icon + text, never colour alone. */
export function HealthBadge({ status }: { status: ProjectHealthStatus }) {
  const { label, cls, Icon } = HEALTH[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        cls,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

export function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  children: ReactNode;
}) {
  const t = {
    ok: 'text-ok border-ok/40 bg-ok/10',
    warn: 'text-warn border-warn/40 bg-warn/10',
    bad: 'text-bad border-bad/40 bg-bad/10',
    muted: 'text-muted border-line bg-raised',
  }[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        t,
      )}
    >
      {children}
    </span>
  );
}

export function FreshnessBadge({
  freshness,
  collectedAt,
}: {
  freshness: Freshness;
  collectedAt: string | null;
}) {
  const now = useNow();
  if (freshness === 'current') return <Pill tone="ok">Current · {timeAgo(collectedAt, now)}</Pill>;
  if (freshness === 'stale')
    return <Pill tone="warn">Stale · last {timeAgo(collectedAt, now)}</Pill>;
  return <Pill tone="muted">Unavailable</Pill>;
}

export function SourceBadge({ source }: { source: DataSource }) {
  return source === 'mock' ? <Pill tone="warn">Demo data</Pill> : <Pill tone="muted">Live</Pill>;
}

export function Meter({
  label,
  valueText,
  fraction,
  detail,
}: {
  label: string;
  valueText: string;
  fraction: number | null;
  detail?: string;
}) {
  const pct = fraction === null ? 0 : Math.min(100, Math.max(0, fraction * 100));
  const tone = pct >= 90 ? 'bg-bad' : pct >= 75 ? 'bg-warn' : 'bg-accent';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-medium tabular-nums">{valueText}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(pct)}
        aria-valuetext={valueText}
        className="h-2 overflow-hidden rounded-full bg-raised"
      >
        <div className={cx('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      {detail && <p className="mt-1 text-xs text-muted">{detail}</p>}
    </div>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'bad' | 'info';
  title: string;
  children?: ReactNode;
}) {
  const cls = {
    warn: 'border-warn/40 bg-warn/10 text-warn',
    bad: 'border-bad/40 bg-bad/10 text-bad',
    info: 'border-info/40 bg-info/10 text-info',
  }[tone];
  return (
    <div
      role={tone === 'info' ? 'status' : 'alert'}
      className={cx('mb-4 rounded-lg border px-3 py-2 text-sm', cls)}
    >
      <p className="font-medium">{title}</p>
      {children && <div className="mt-0.5 text-fg">{children}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center">
      {icon ?? <CircleSlash className="h-6 w-6 text-muted" aria-hidden />}
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
    </div>
  );
}

export function UnavailableNote({ info }: { info: NotAvailable }) {
  return <EmptyState title="Not available yet">{info.reason}</EmptyState>;
}

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <p role="status" className="py-8 text-center text-sm text-muted">
    {label}…
  </p>
);
