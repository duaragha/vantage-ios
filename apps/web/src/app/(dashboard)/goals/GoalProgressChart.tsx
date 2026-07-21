'use client';

import * as React from 'react';
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface GoalProgressChartProps {
  snapshots: Array<{ date: Date; valueCad: number }>;
  targetCad: number;
  /** Forward DCA projection path (month offset + ISO date + projected balance). */
  projectionSeries?: Array<{ month: number; date: string; projected: number }>;
  /** Target date — drawn as a vertical marker so the projection has a finish line. */
  targetDate?: Date | null;
}

const cadFmt = (v: number) =>
  v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

const dateFmt = (ms: number) =>
  new Date(ms).toLocaleDateString('en-CA', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });

// One row per timestamp. `actual` carries the snapshot history; `projected`
// carries the forward DCA path. They overlap by one point (today) so the two
// lines visually connect rather than leaving a gap.
interface Row {
  t: number;
  actual?: number;
  projected?: number;
}

export function GoalProgressChart({
  snapshots,
  targetCad,
  projectionSeries,
  targetDate,
}: GoalProgressChartProps): React.ReactElement {
  const hasProjection = !!projectionSeries && projectionSeries.length >= 2;

  // Without snapshot history AND without a projection there's nothing to draw.
  if (snapshots.length < 2 && !hasProjection) {
    return (
      <div className="text-sm text-zinc-500">
        Progress history will appear here after the nightly snapshot runs. Add a contribution plan
        to project this goal forward now.
      </div>
    );
  }

  const rowByT = new Map<number, Row>();
  const upsert = (t: number, patch: Partial<Row>) => {
    const existing = rowByT.get(t) ?? { t };
    rowByT.set(t, { ...existing, ...patch });
  };

  for (const s of snapshots) upsert(s.date.getTime(), { actual: s.valueCad });

  // Anchor the projection to the latest actual value so the dashed line starts
  // exactly where the solid line ends (no visual jump at "today").
  let anchorValue: number | null = null;
  let anchorT: number | null = null;
  if (snapshots.length > 0) {
    const last = snapshots[snapshots.length - 1]!;
    anchorValue = last.valueCad;
    anchorT = last.date.getTime();
  }

  if (hasProjection) {
    for (const p of projectionSeries!) {
      const t = new Date(p.date + 'T00:00:00').getTime();
      upsert(t, { projected: p.projected });
    }
    // Seed the projection line at the anchor point so it joins the actual area.
    if (anchorT !== null && anchorValue !== null) {
      upsert(anchorT, { projected: anchorValue });
    } else if (projectionSeries![0]) {
      // No snapshots — start the projection from its own month-0 point.
      const first = projectionSeries![0]!;
      upsert(new Date(first.date + 'T00:00:00').getTime(), { projected: first.projected });
    }
  }

  const data: Row[] = Array.from(rowByT.values()).sort((a, b) => a.t - b.t);

  const allValues = data.flatMap((d) =>
    [d.actual, d.projected].filter((v): v is number => v != null),
  );
  const maxValue = Math.max(targetCad, ...allValues);
  const yMax = maxValue * 1.05;

  return (
    <div className="min-w-0">
      <div className="h-52 min-w-0 sm:h-56">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0}
          initialDimension={{ width: 320, height: 208 }}
        >
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="goalValueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              scale="time"
              tickFormatter={dateFmt}
              tick={{ fill: '#71717a', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              minTickGap={40}
            />
            <YAxis
              domain={[0, yMax]}
              tickFormatter={(v: number) => cadFmt(v)}
              tick={{ fill: '#71717a', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <Tooltip
              contentStyle={{
                background: '#09090b',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: '#a1a1aa' }}
              labelFormatter={(t) => dateFmt(Number(t))}
              formatter={(v, name) => [
                cadFmt(Number(v)),
                name === 'projected' ? 'Projected' : 'Value',
              ]}
            />
            {targetCad > 0 ? (
              <ReferenceLine
                y={targetCad}
                stroke="#fbbf24"
                strokeDasharray="4 4"
                label={{
                  value: `Target ${cadFmt(targetCad)}`,
                  fill: '#fbbf24',
                  fontSize: 11,
                  position: 'insideTopRight',
                }}
              />
            ) : null}
            {targetDate ? (
              <ReferenceLine
                x={targetDate.getTime()}
                stroke="rgba(251,191,36,0.4)"
                strokeDasharray="2 4"
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="actual"
              stroke="#10b981"
              strokeWidth={2}
              fill="url(#goalValueFill)"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {hasProjection ? (
              <Line
                type="monotone"
                dataKey="projected"
                stroke="#38bdf8"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {hasProjection ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
          <span>
            <span className="mr-1 inline-block h-0.5 w-3 align-middle bg-emerald-500" />
            Actual
          </span>
          <span>
            <span className="mr-1 inline-block h-0.5 w-3 align-middle bg-sky-400" />
            Projected (contributions + expected return)
          </span>
        </div>
      ) : null}
    </div>
  );
}
