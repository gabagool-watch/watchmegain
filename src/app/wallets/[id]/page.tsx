import { notFound } from 'next/navigation';
import Link from 'next/link';
import { StatsCard } from '@/components/StatsCard';
import { PositionsTable } from '@/components/PositionsTable';
import { TradesTable } from '@/components/TradesTable';
import { PnLChart } from '@/components/PnLChart';
import { formatAddress, timeAgo } from '@/lib/utils';

export const dynamic = 'force-dynamic';

async function getWallet(id: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/wallets/${id}`, {
      cache: 'no-store',
    });
    
    if (!res.ok) {
      return null;
    }
    
    return res.json();
  } catch (error) {
    console.error('Failed to fetch wallet:', error);
    return null;
  }
}

export default async function WalletDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const wallet = await getWallet(params.id);

  if (!wallet) {
    notFound();
  }

  const stats = wallet.stats || {
    totalPnl: 0,
    totalRealizedPnl: 0,
    totalUnrealizedPnl: 0,
    totalVolume: 0,
    totalTrades: 0,
    openPositionsCount: 0,
    closedPositionsCount: 0,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link
            href="/wallets"
            className="text-sm text-surface-400 hover:text-surface-200 mb-2 inline-block"
          >
            ← Back to Wallets
          </Link>
          <h1 className="text-3xl font-bold text-surface-50">
            {wallet.alias || 'Unnamed Wallet'}
          </h1>
          <div className="flex items-center gap-4 mt-2">
            <span className="font-mono text-surface-400">
              {formatAddress(wallet.address, 8)}
            </span>
            <a
              href={`https://polygonscan.com/address/${wallet.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary-400 hover:underline"
            >
              View on Polygonscan ↗
            </a>
          </div>
          <p className="text-sm text-surface-500 mt-1">
            First seen: {timeAgo(wallet.createdAt)}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatsCard
          title="Total PnL"
          value={stats.totalPnl}
          format="pnl"
        />
        <StatsCard
          title="Realized PnL"
          value={stats.totalRealizedPnl}
          format="pnl"
        />
        <StatsCard
          title="Unrealized PnL"
          value={stats.totalUnrealizedPnl}
          format="pnl"
        />
        <StatsCard
          title="Total Volume"
          value={stats.totalVolume}
          format="currency"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatsCard
          title="Total Trades"
          value={stats.totalTrades}
          format="number"
        />
        <StatsCard
          title="Open Positions"
          value={stats.openPositionsCount}
          format="number"
        />
        <StatsCard
          title="Closed Positions"
          value={stats.closedPositionsCount}
          format="number"
        />
      </div>

      {/* PnL Chart */}
      {wallet.snapshots && wallet.snapshots.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-surface-100 mb-4">
            PnL History
          </h2>
          <PnLChart snapshots={wallet.snapshots} />
        </div>
      )}

      {/* Open Positions */}
      <div className="card">
        <h2 className="text-lg font-semibold text-surface-100 mb-4">
          Open Positions ({wallet.openPositions?.length || 0})
        </h2>
        <PositionsTable positions={wallet.openPositions || []} />
      </div>

      {/* Closed Positions */}
      <div className="card">
        <h2 className="text-lg font-semibold text-surface-100 mb-4">
          Closed Positions ({wallet.closedPositions?.length || 0})
        </h2>
        <PositionsTable positions={wallet.closedPositions || []} />
      </div>

      {/* Recent Trades */}
      <div className="card">
        <h2 className="text-lg font-semibold text-surface-100 mb-4">
          Recent Trades
        </h2>
        <TradesTable trades={wallet.trades || []} showWallet={false} />
      </div>
    </div>
  );
}
