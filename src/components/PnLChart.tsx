'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';

interface Snapshot {
  timestamp: string;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

interface PnLChartProps {
  snapshots: Snapshot[];
  className?: string;
}

export function PnLChart({ snapshots, className }: PnLChartProps) {
  // Reverse to show oldest first
  const data = [...snapshots].reverse().map((s) => ({
    ...s,
    date: new Date(s.timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    }),
    totalPnl: s.realizedPnl + s.unrealizedPnl,
  }));

  if (data.length === 0) {
    return (
      <div className={className}>
        <div className="h-64 flex items-center justify-center text-surface-500">
          No data available
        </div>
      </div>
    );
  }

  const minPnl = Math.min(...data.map((d) => d.totalPnl));
  const maxPnl = Math.max(...data.map((d) => d.totalPnl));
  const isPositive = data[data.length - 1]?.totalPnl >= 0;

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height={256}>
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor={isPositive ? '#22c55e' : '#ef4444'}
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor={isPositive ? '#22c55e' : '#ef4444'}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            axisLine={false}
            tickLine={false}
            tick={{ fill: '#71717a', fontSize: 12 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: '#71717a', fontSize: 12 }}
            tickFormatter={(value) => formatCurrency(value, 0)}
            domain={[minPnl * 1.1, maxPnl * 1.1]}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const data = payload[0].payload;
              return (
                <div className="card !p-2 !bg-surface-800 text-sm">
                  <p className="text-surface-400">{data.date}</p>
                  <p className={data.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {formatCurrency(data.totalPnl)}
                  </p>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="totalPnl"
            stroke={isPositive ? '#22c55e' : '#ef4444'}
            strokeWidth={2}
            fill="url(#pnlGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
