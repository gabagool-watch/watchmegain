'use client';

import Link from 'next/link';
import { cn, formatCurrency, formatNumber, formatDateTime, formatAddress } from '@/lib/utils';

interface Trade {
  id: string;
  txHash: string;
  blockTime: string;
  outcome: number;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  cost: number;
  fee: number;
  market: {
    conditionId: string;
    title: string;
    outcomes: { name: string; index: number }[];
  };
  wallet?: {
    address: string;
    alias?: string | null;
  };
}

interface TradesTableProps {
  trades: Trade[];
  showMarket?: boolean;
  showWallet?: boolean;
  className?: string;
}

export function TradesTable({ 
  trades, 
  showMarket = true, 
  showWallet = false,
  className 
}: TradesTableProps) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full">
        <thead>
          <tr className="border-b border-surface-800 text-left text-sm text-surface-400">
            <th className="pb-3 font-medium">Time</th>
            {showWallet && <th className="pb-3 font-medium">Wallet</th>}
            {showMarket && <th className="pb-3 font-medium">Market</th>}
            <th className="pb-3 font-medium">Side</th>
            <th className="pb-3 font-medium">Outcome</th>
            <th className="pb-3 font-medium text-right">Price</th>
            <th className="pb-3 font-medium text-right">Size</th>
            <th className="pb-3 font-medium text-right">Cost</th>
            <th className="pb-3 font-medium text-right">Fee</th>
            <th className="pb-3 font-medium">Tx</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const outcomeName = trade.market.outcomes.find(
              (o) => o.index === trade.outcome
            )?.name || `Outcome ${trade.outcome}`;

            return (
              <tr key={trade.id} className="table-row">
                <td className="py-3 text-sm text-surface-400">
                  {formatDateTime(trade.blockTime)}
                </td>
                {showWallet && trade.wallet && (
                  <td className="py-3">
                    <span className="text-sm font-mono text-surface-400">
                      {trade.wallet.alias || formatAddress(trade.wallet.address)}
                    </span>
                  </td>
                )}
                {showMarket && (
                  <td className="py-3 max-w-xs">
                    <Link
                      href={`/markets/${trade.market.conditionId}`}
                      className="hover:text-primary-400 transition-colors line-clamp-1 text-sm"
                    >
                      {trade.market.title}
                    </Link>
                  </td>
                )}
                <td className="py-3">
                  <span className={cn(
                    'badge',
                    trade.side === 'BUY' ? 'badge-green' : 'badge-red'
                  )}>
                    {trade.side}
                  </span>
                </td>
                <td className="py-3">
                  <span className={cn(
                    'badge',
                    trade.outcome === 0 ? 'badge-blue' : 'badge-yellow'
                  )}>
                    {outcomeName}
                  </span>
                </td>
                <td className="py-3 text-right font-mono text-surface-300">
                  {formatCurrency(trade.price)}
                </td>
                <td className="py-3 text-right font-mono text-surface-300">
                  {formatNumber(trade.size, 0)}
                </td>
                <td className="py-3 text-right font-mono text-surface-300">
                  {formatCurrency(trade.cost)}
                </td>
                <td className="py-3 text-right font-mono text-surface-400 text-sm">
                  {formatCurrency(trade.fee)}
                </td>
                <td className="py-3">
                  <a
                    href={`https://polygonscan.com/tx/${trade.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-primary-400 hover:underline"
                  >
                    {formatAddress(trade.txHash, 4)}
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {trades.length === 0 && (
        <div className="py-8 text-center text-surface-500">
          No trades found.
        </div>
      )}
    </div>
  );
}
