import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsHistory } from '@hlcc/shared';
import { useHistory } from '../hooks';
import {
  Card,
  EmptyState,
  FreshnessBadge,
  Notice,
  PageHeader,
  SourceBadge,
  Spinner,
} from '../components/ui';

const RANGES = [
  { m: 15, label: '15 min' },
  { m: 60, label: '1 hour' },
  { m: 360, label: '6 hours' },
  { m: 1440, label: '24 hours' },
];
const GiB = 1024 ** 3;
const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Chart({
  title,
  unit,
  data,
  dataKey,
  domain,
  color,
}: {
  title: string;
  unit: string;
  data: { ts: number; v: number | null }[];
  dataKey: 'v';
  domain: [number, number];
  color: string;
}) {
  return (
    <Card title={`${title} (${unit})`}>
      <div className="h-64" role="img" aria-label={`${title} over time in ${unit}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={hhmm}
              stroke="var(--muted)"
              fontSize={12}
            />
            <YAxis
              domain={domain}
              stroke="var(--muted)"
              fontSize={12}
              unit={unit === '%' ? '%' : ''}
            />
            <Tooltip
              labelFormatter={(l) => new Date(Number(l)).toLocaleString()}
              formatter={(v) => [`${Number(v).toFixed(2)} ${unit}`, title]}
              contentStyle={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                color: 'var(--fg)',
              }}
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function MonitoringBody({
  h,
  minutes,
  setMinutes,
}: {
  h: MetricsHistory;
  minutes: number;
  setMinutes: (m: number) => void;
}) {
  const total = h.points.find((p) => p.memTotalBytes)?.memTotalBytes ?? 8 * GiB;
  return (
    <>
      <PageHeader
        title="Monitoring"
        subtitle={`Host history · ${h.points.length} points · ${hhmm(h.from)}–${hhmm(h.to)}`}
        right={
          <span className="flex flex-wrap items-center gap-2">
            <SourceBadge source={h.source} />
            <FreshnessBadge freshness={h.freshness} collectedAt={h.collectedAt} />
            <label className="sr-only" htmlFor="range">
              Time range
            </label>
            <select
              id="range"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
            >
              {RANGES.map((r) => (
                <option key={r.m} value={r.m}>
                  {r.label}
                </option>
              ))}
            </select>
          </span>
        }
      />
      {h.freshness === 'stale' && (
        <Notice tone="warn" title="History ends in the past">
          The newest sample is old; the chart does not extend to now.
        </Notice>
      )}
      {h.points.length === 0 ? (
        <EmptyState title="No samples in this range">
          History appears once the collector has stored data. Nothing is interpolated or invented.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Chart
            title="CPU utilisation"
            unit="%"
            dataKey="v"
            domain={[0, 100]}
            color="var(--accent)"
            data={h.points.map((p) => ({ ts: p.ts, v: p.cpuPercent }))}
          />
          <Chart
            title="Memory used"
            unit="GiB"
            dataKey="v"
            domain={[0, Math.ceil(total / GiB)]}
            color="var(--info)"
            data={h.points.map((p) => ({
              ts: p.ts,
              v: p.memUsedBytes === null ? null : p.memUsedBytes / GiB,
            }))}
          />
        </div>
      )}
    </>
  );
}

export default function Monitoring() {
  const [minutes, setMinutes] = useState(60);
  const { data, error, isLoading } = useHistory(minutes);
  if (isLoading) return <Spinner />;
  if (error || !data) return <Notice tone="bad" title="Cannot load history" />;
  return <MonitoringBody h={data} minutes={minutes} setMinutes={setMinutes} />;
}
