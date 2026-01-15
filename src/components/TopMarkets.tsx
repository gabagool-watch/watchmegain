'use client';

import Link from 'next/link';
import { cn, formatCurrency } from '@/lib/utils';

interface Market {
  id: string;
  conditionId: string;
  title: string;
  status: string;
  volume: number;
  openInterest: number;
}

interface TopMarketsProps {
  markets: Market[];
  className?: string;
}

export function TopMarkets({ markets, className }: TopMarketsProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {markets.map((market, index) => (
        <Link
          key={market.id}
          href={`/markets/${market.conditionId}`}
          className="block card hover:border-primary-500/50 transition-colors"
        >
          <div className="flex items-start gap-3">
            <span className="text-lg font-bold text-surface-500">
              {index + 1}
            </span>
            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-surface-100 line-clamp-2 text-sm">
                {market.title}
              </h4>
              <div className="flex items-center gap-4 mt-2 text-xs text-surface-400">
                <span>Vol: {formatCurrency(market.volume)}</span>
                <span>OI: {formatCurrency(market.openInterest)}</span>
                <span className={cn(
                  'badge',
                  market.status === 'OPEN' ? 'badge-green' : 'badge-gray'
                )}>
                  {market.status}
                </span>
              </div>
            </div>
          </div>
        </Link>
      ))}
      {markets.length === 0 && (
        <div className="py-8 text-center text-surface-500">
          No markets found.
        </div>
      )}
    </div>
  );
}
