import { notFound } from 'next/navigation';
import Link from 'next/link';
import { StatsCard } from '@/components/StatsCard';
import { PositionsTable } from '@/components/PositionsTable';
import { TradesTable } from '@/components/TradesTable';
import { formatCurrency, cn } from '@/lib/utils';

async function getMarket(conditionId: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/markets/${conditionId}`, {
      cache: 'no-store',
    });
    
    if (!res.ok) {
      return null;
    }
    
    return res.json();
  } catch (error) {
    console.error('Failed to fetch market:', error);
    return null;
  }
}

export default async function MarketDetailPage({
  params,
}: {
  params: { conditionId: string };
}) {
  const market = await getMarket(params.conditionId);

  if (!market) {
    notFound();
  }

  const stats = market.stats || {
    totalVolume: 0,
    uniqueTraders: 0,
    openInterest: 0,
    totalTrades: 0,
    totalPositions: 0,
  };

  // Parse outcomes
  const outcomes = market.outcomes as { name: string; index: number }[];

  // Group positions by wallet for display
  const positionsWithWallet = market.positions?.map((p: any) => ({
    ...p,
    market: {
      conditionId: market.conditionId,
      title: market.title,
      outcomes: market.outcomes,
    },
  })) || [];

  // Add wallet to trades
  const tradesWithMarket = market.trades?.map((t: any) => ({
    ...t,
    market: {
      conditionId: market.conditionId,
      title: market.title,
      outcomes: market.outcomes,
    },
  })) || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/markets"
          className="text-sm text-surface-400 hover:text-surface-200 mb-2 inline-block"
        >
          ← Back to Markets
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h1 className="text-3xl font-bold text-surface-50">
              {market.title}
            </h1>
            {market.description && (
              <p className="text-surface-400 mt-2">
                {market.description}
              </p>
            )}
          </div>
          <span className={cn(
            'badge',
            market.status === 'OPEN' ? 'badge-green' : 
            market.status === 'RESOLVED' ? 'badge-blue' : 'badge-gray'
          )}>
            {market.status}
          </span>
        </div>

        {/* Market Info */}
        <div className="flex flex-wrap items-center gap-4 mt-4 text-sm text-surface-400">
          <span>
            Condition ID: <code className="font-mono text-surface-300">{market.conditionId}</code>
          </span>
          {market.endTime && (
            <span>
              End Time: {new Date(market.endTime).toLocaleString()}
            </span>
          )}
        </div>

        {/* Outcomes */}
        <div className="flex items-center gap-2 mt-4">
          <span className="text-sm text-surface-400">Outcomes:</span>
          {outcomes.map((outcome) => (
            <span
              key={outcome.index}
              className={cn(
                'badge',
                outcome.index === 0 ? 'badge-green' : 'badge-red'
              )}
            >
              {outcome.name}
              {market.resolutionPrice && (
                <span className="ml-1 opacity-70">
                  ({market.resolutionPrice[outcome.index]?.toFixed(2) || '?'})
                </span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatsCard
          title="Total Volume"
          value={stats.totalVolume}
          format="currency"
        />
        <StatsCard
          title="Open Interest"
          value={stats.openInterest}
          format="currency"
        />
        <StatsCard
          title="Unique Traders"
          value={stats.uniqueTraders}
          format="number"
        />
        <StatsCard
          title="Total Trades"
          value={stats.totalTrades}
          format="number"
        />
        <StatsCard
          title="Positions"
          value={stats.totalPositions}
          format="number"
        />
      </div>

      {/* Positions */}
      <div className="card">
        <h2 className="text-lg font-semibold text-surface-100 mb-4">
          Wallet Positions ({positionsWithWallet.length})
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-800 text-left text-sm text-surface-400">
                <th className="pb-3 font-medium">Wallet</th>
                <th className="pb-3 font-medium">Outcome</th>
                <th className="pb-3 font-medium text-right">Shares</th>
                <th className="pb-3 font-medium text-right">Avg Entry</th>
                <th className="pb-3 font-medium text-right">Realized PnL</th>
                <th className="pb-3 font-medium text-right">Unrealized PnL</th>
                <th className="pb-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {positionsWithWallet.map((position: any) => {
                const outcomeName = outcomes.find(
                  (o) => o.index === position.outcome
                )?.name || `Outcome ${position.outcome}`;

                return (
                  <tr key={position.id} className="table-row">
                    <td className="py-3">
                      <Link
                        href={`/wallets/${position.wallet.id}`}
                        className="hover:text-primary-400 transition-colors"
                      >
                        {position.wallet.alias || position.wallet.address.slice(0, 10) + '...'}
                      </Link>
                    </td>
                    <td className="py-3">
                      <span className={cn(
                        'badge',
                        position.outcome === 0 ? 'badge-green' : 'badge-red'
                      )}>
                        {outcomeName}
                      </span>
                    </td>
                    <td className="py-3 text-right font-mono text-surface-300">
                      {position.shares.toFixed(2)}
                    </td>
                    <td className="py-3 text-right font-mono text-surface-300">
                      {formatCurrency(position.avgEntryPrice)}
                    </td>
                    <td className={cn(
                      'py-3 text-right font-medium',
                      position.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'
                    )}>
                      {formatCurrency(position.realizedPnl)}
                    </td>
                    <td className={cn(
                      'py-3 text-right font-medium',
                      position.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'
                    )}>
                      {formatCurrency(position.unrealizedPnl)}
                    </td>
                    <td className="py-3">
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
          {positionsWithWallet.length === 0 && (
            <div className="py-8 text-center text-surface-500">
              No positions in this market.
            </div>
          )}
        </div>
      </div>

      {/* Recent Trades */}
      <div className="card">
        <h2 className="text-lg font-semibold text-surface-100 mb-4">
          Recent Trades
        </h2>
        <TradesTable 
          trades={tradesWithMarket} 
          showMarket={false} 
          showWallet={true}
        />
      </div>
    </div>
  );
}
