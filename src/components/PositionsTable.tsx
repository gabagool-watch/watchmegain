'use client';

import Link from 'next/link';
import { cn, formatCurrency, formatPnL, formatNumber } from '@/lib/utils';

interface Position {
  id: string;
  marketId: string;
  outcome: number;
  shares: number;
  avgEntryPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  status: 'OPEN' | 'CLOSED';
  market: {
    conditionId: string;
    title: string;
    outcomes: { name: string; index: number }[];
  };
}

interface PositionsTableProps {
  positions: Position[];
  showMarket?: boolean;
  className?: string;
}

export function PositionsTable({ positions, showMarket = true, className }: PositionsTableProps) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full">
        <thead>
          <tr className="border-b border-surface-800 text-left text-sm text-surface-400">
            {showMarket && <th className="pb-3 font-medium">Market</th>}
            <th className="pb-3 font-medium">Outcome</th>
            <th className="pb-3 font-medium text-right">Shares</th>
            <th className="pb-3 font-medium text-right">Avg Entry</th>
            <th className="pb-3 font-medium text-right">Realized PnL</th>
            <th className="pb-3 font-medium text-right">Unrealized PnL</th>
            <th className="pb-3 font-medium text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const realizedPnl = formatPnL(position.realizedPnl);
            const unrealizedPnl = formatPnL(position.unrealizedPnl);
            const outcomeName = position.market.outcomes.find(
              (o) => o.index === position.outcome
            )?.name || `Outcome ${position.outcome}`;

            return (
              <tr key={position.id} className="table-row">
                {showMarket && (
                  <td className="py-3 max-w-xs">
                    <Link
                      href={`/markets/${position.market.conditionId}`}
                      className="hover:text-primary-400 transition-colors line-clamp-2"
                    >
                      {position.market.title}
                    </Link>
                  </td>
                )}
                <td className="py-3">
                  <span className={cn(
                    'badge',
                    position.outcome === 0 ? 'badge-green' : 'badge-red'
                  )}>
                    {outcomeName}
                  </span>
                </td>
                <td className="py-3 text-right font-mono text-surface-300">
                  {formatNumber(position.shares, 2)}
                </td>
                <td className="py-3 text-right font-mono text-surface-300">
                  {formatCurrency(position.avgEntryPrice)}
                </td>
                <td className={cn('py-3 text-right font-medium', realizedPnl.color)}>
                  {realizedPnl.text}
                </td>
                <td className={cn('py-3 text-right font-medium', unrealizedPnl.color)}>
                  {unrealizedPnl.text}
                </td>
                <td className="py-3 text-right">
                  <span className={cn(
                    'badge',
                    position.status === 'OPEN' ? 'badge-blue' : 'badge-gray'
                  )}>
                    {position.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {positions.length === 0 && (
        <div className="py-8 text-center text-surface-500">
          No positions found.
        </div>
      )}
    </div>
  );
}
