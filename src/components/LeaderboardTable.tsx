'use client';

import Link from 'next/link';
import { cn, formatAddress, formatCurrency, formatPnL } from '@/lib/utils';

interface WalletStats {
  id: string;
  address: string;
  alias?: string | null;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  volume: number;
  volume30d: number;
  trades: number;
  openPositions: number;
}

interface LeaderboardTableProps {
  wallets: WalletStats[];
  className?: string;
}

export function LeaderboardTable({ wallets, className }: LeaderboardTableProps) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full">
        <thead>
          <tr className="border-b border-surface-800 text-left text-sm text-surface-400">
            <th className="pb-3 font-medium">#</th>
            <th className="pb-3 font-medium">Wallet</th>
            <th className="pb-3 font-medium text-right">Total PnL</th>
            <th className="pb-3 font-medium text-right">Realized</th>
            <th className="pb-3 font-medium text-right">Unrealized</th>
            <th className="pb-3 font-medium text-right">Volume (30d)</th>
            <th className="pb-3 font-medium text-right">Trades</th>
            <th className="pb-3 font-medium text-right">Open Pos.</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet, index) => {
            const totalPnl = formatPnL(wallet.totalPnl);
            const realizedPnl = formatPnL(wallet.realizedPnl);
            const unrealizedPnl = formatPnL(wallet.unrealizedPnl);

            return (
              <tr key={wallet.id} className="table-row">
                <td className="py-3 text-surface-500">{index + 1}</td>
                <td className="py-3">
                  <Link 
                    href={`/wallets/${wallet.id}`}
                    className="hover:text-primary-400 transition-colors"
                  >
                    <div className="flex flex-col">
                      {wallet.alias && (
                        <span className="font-medium text-surface-100">
                          {wallet.alias}
                        </span>
                      )}
                      <span className="text-sm font-mono text-surface-400">
                        {formatAddress(wallet.address)}
                      </span>
                    </div>
                  </Link>
                </td>
                <td className={cn('py-3 text-right font-medium', totalPnl.color)}>
                  {totalPnl.text}
                </td>
                <td className={cn('py-3 text-right text-sm', realizedPnl.color)}>
                  {realizedPnl.text}
                </td>
                <td className={cn('py-3 text-right text-sm', unrealizedPnl.color)}>
                  {unrealizedPnl.text}
                </td>
                <td className="py-3 text-right text-surface-300">
                  {formatCurrency(wallet.volume30d)}
                </td>
                <td className="py-3 text-right text-surface-300">
                  {wallet.trades}
                </td>
                <td className="py-3 text-right text-surface-300">
                  {wallet.openPositions}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {wallets.length === 0 && (
        <div className="py-8 text-center text-surface-500">
          No wallets tracked yet. Add wallets in the Admin section.
        </div>
      )}
    </div>
  );
}
