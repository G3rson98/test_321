/**
 * Gráfico de p95 (chunk diferido con Recharts, ESP §17.4). Recibe agregados del backend (≤ 1000 puntos/serie);
 * no recalcula percentiles. Puntos con muestra insuficiente quedan como hueco (no se inventa p95).
 */
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PerfResponse } from '@/lib/api/types';
import { formatDateTimeShort, formatTime } from '@/lib/format';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: PerfResponse['series'][number]['points'];
  comparison: PerfResponse['series'][number]['comparison'];
}

const fmt = (n: number) => n.toLocaleString('es-BO', { maximumFractionDigits: 1 });

export default function PerfChart({
  series,
  thresholdMs,
  marks,
  granularity,
}: {
  series: ChartSeries[];
  thresholdMs: number | null;
  marks: { ts: string; label: string }[];
  granularity: 'hour' | 'day' | 'minute';
}) {
  const buckets = new Map<string, Record<string, number | string | null>>();
  for (const s of series) {
    for (const p of s.points) {
      const row = buckets.get(p.bucketStart) ?? { t: p.bucketStart };
      row[s.key] = p.p95Ms !== null ? p.p95Ms / 1000 : null;
      row[`${s.key}__n`] = p.completed;
      row[`${s.key}__q`] = p.quality;
      buckets.set(p.bucketStart, row);
    }
    for (const p of s.comparison ?? []) {
      const row = buckets.get(p.bucketStart) ?? { t: p.bucketStart };
      row[`${s.key}__prev`] = p.p95Ms !== null ? p.p95Ms / 1000 : null;
      buckets.set(p.bucketStart, row);
    }
  }
  const data = [...buckets.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const tick = (t: string) => (granularity === 'day' ? formatDateTimeShort(t).slice(0, 6) : formatTime(t));
  const nearest = (ts: string) => {
    const target = Date.parse(ts);
    let best: string | null = null;
    let bestD = Infinity;
    for (const r of data) {
      const d = Math.abs(Date.parse(String(r.t)) - target);
      if (d < bestD) {
        bestD = d;
        best = String(r.t);
      }
    }
    return best;
  };
  return (
    <div className="h-[300px] w-full" role="img" aria-label="Gráfico de p95 por intervalo">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 24, bottom: 0, left: -10 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="4 4" />
          <XAxis dataKey="t" tickFormatter={tick} stroke="var(--chart-axis)" tick={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} />
          <YAxis stroke="var(--chart-axis)" tick={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} tickFormatter={(v: number) => fmt(v)} />
          <Tooltip
            labelFormatter={(t) => formatDateTimeShort(String(t))}
            formatter={(value, name, item) => {
              const key = String(item.dataKey ?? '');
              const n = (item.payload as Record<string, unknown>)[`${key}__n`];
              const q = (item.payload as Record<string, unknown>)[`${key}__q`];
              return [value === null || value === undefined ? 'muestra insuficiente' : `${fmt(Number(value))} s · n=${n ?? '?'}${q === 'insuficiente' ? ' (insuficiente)' : ''}`, name];
            }}
          />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 15 }} />
          {thresholdMs !== null ? (
            <ReferenceLine y={thresholdMs / 1000} stroke="var(--chart-threshold)" strokeDasharray="5 5" label={{ value: 'Umbral', fill: 'var(--chart-threshold)', fontSize: 12 }} />
          ) : null}
          {marks.map((m) => {
            const x = nearest(m.ts);
            return x ? <ReferenceLine key={m.ts} x={x} stroke="var(--chart-event)" label={{ value: m.label, fill: 'var(--chart-4)', fontSize: 12, position: 'insideTop', dy: 90 }} /> : null;
          })}
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          ))}
          {series.some((s) => s.comparison) &&
            series.map((s) => (
              <Line key={`${s.key}__prev`} type="monotone" dataKey={`${s.key}__prev`} name={`${s.label} (período anterior)`} stroke={s.color} strokeOpacity={0.45} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
