/**
 * SectorDonut — Recharts pie chart of sector exposure.
 */

'use client';

import * as React from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const COLORS = [
  '#5eead4',
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#facc15',
  '#34d399',
  '#fb923c',
  '#64748b',
];

interface Slice {
  name: string;
  value: number;
}

export function SectorDonut({ data }: { data: Slice[] }): React.ReactElement {
  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center font-mono text-xs text-muted-foreground">
        No sectors yet.
      </div>
    );
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={0}
        initialDimension={{ width: 320, height: 160 }}
      >
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            innerRadius={40}
            outerRadius={70}
            strokeWidth={1}
            stroke="rgba(0,0,0,0.6)"
            isAnimationActive={false}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: 'rgba(10,10,11,0.92)',
              border: '1px solid rgba(255,255,255,0.12)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: '#fff',
            }}
            formatter={(v, _name, entry) => {
              const num = typeof v === 'number' ? v : Number(v ?? 0);
              const payload = (entry as { payload?: unknown } | undefined)?.payload;
              const name =
                payload && typeof payload === 'object' && 'name' in payload
                  ? ((payload as Slice).name ?? '')
                  : '';
              return [`$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, name];
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
