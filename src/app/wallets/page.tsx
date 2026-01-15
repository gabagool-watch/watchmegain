import Link from 'next/link';
import { formatAddress, formatCurrency, formatPnL, cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

async function getWallets() {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/wallets`, {
      cache: 'no-store',
    });
    
    if (!res.ok) {
      return [];
    }
    
    return res.json();
  } catch (error) {
    console.error('Failed to fetch wallets:', error);
    return [];
  }
}

export default async function WalletsPage() {
  const wallets = await getWallets();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-surface-50">Wallets</h1>
          <p className="text-surface-400 mt-1">
            All tracked wallets and their performance
          </p>
        </div>
        <Link href="/admin" className="btn-primary">
          Manage Wallets
        </Link>
      </div>

      <div className="grid gap-4">
        {wallets.map((wallet: any) => {
          const totalPnl = formatPnL(wallet.stats.totalPnl);
          const realizedPnl = formatPnL(wallet.stats.totalRealizedPnl);
          const unrealizedPnl = formatPnL(wallet.stats.totalUnrealizedPnl);

          return (
            <Link
              key={wallet.id}
              href={`/wallets/${wallet.id}`}
              className="card hover:border-primary-500/50 transition-all hover:shadow-lg"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    {wallet.alias && (
                      <span className="text-lg font-semibold text-surface-100">
                        {wallet.alias}
                      </span>
                    )}
                    <span className="font-mono text-sm text-surface-400">
                      {formatAddress(wallet.address, 6)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-sm text-surface-400">
                    <span>{wallet.stats.totalTrades} trades</span>
                    <span>{wallet.stats.openPositions} open positions</span>
                    <span>Vol: {formatCurrency(wallet.stats.totalVolume)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className="text-xs text-surface-500">Realized</p>
                    <p className={cn('font-medium', realizedPnl.color)}>
                      {realizedPnl.text}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-surface-500">Unrealized</p>
                    <p className={cn('font-medium', unrealizedPnl.color)}>
                      {unrealizedPnl.text}
                    </p>
                  </div>
                  <div className="text-right min-w-[100px]">
                    <p className="text-xs text-surface-500">Total PnL</p>
                    <p className={cn('text-xl font-bold', totalPnl.color)}>
                      {totalPnl.text}
                    </p>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}

        {wallets.length === 0 && (
          <div className="card text-center py-12">
            <p className="text-surface-400 mb-4">No wallets tracked yet.</p>
            <Link href="/admin" className="btn-primary">
              Add Your First Wallet
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
