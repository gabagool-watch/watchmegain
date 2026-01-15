import Link from 'next/link';
import { formatCurrency, cn } from '@/lib/utils';

async function getMarkets(status?: string, search?: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    
    const res = await fetch(`${baseUrl}/api/markets?${params}`, {
      cache: 'no-store',
    });
    
    if (!res.ok) {
      return { data: [], total: 0 };
    }
    
    return res.json();
  } catch (error) {
    console.error('Failed to fetch markets:', error);
    return { data: [], total: 0 };
  }
}

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: { status?: string; search?: string };
}) {
  const { data: markets, total } = await getMarkets(
    searchParams.status,
    searchParams.search
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-surface-50">Markets</h1>
          <p className="text-surface-400 mt-1">
            {total} markets tracked
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <Link
          href="/markets"
          className={cn(
            'btn-secondary',
            !searchParams.status && 'bg-primary-500/20 text-primary-400'
          )}
        >
          All
        </Link>
        <Link
          href="/markets?status=OPEN"
          className={cn(
            'btn-secondary',
            searchParams.status === 'OPEN' && 'bg-primary-500/20 text-primary-400'
          )}
        >
          Open
        </Link>
        <Link
          href="/markets?status=RESOLVED"
          className={cn(
            'btn-secondary',
            searchParams.status === 'RESOLVED' && 'bg-primary-500/20 text-primary-400'
          )}
        >
          Resolved
        </Link>
      </div>

      {/* Markets Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {markets.map((market: any) => (
          <Link
            key={market.id}
            href={`/markets/${market.conditionId}`}
            className="card hover:border-primary-500/50 transition-all hover:shadow-lg"
          >
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-surface-100 line-clamp-2">
                  {market.title}
                </h3>
                <p className="text-sm text-surface-400 mt-2 line-clamp-2">
                  {market.description}
                </p>
              </div>
              <span className={cn(
                'badge shrink-0',
                market.status === 'OPEN' ? 'badge-green' : 
                market.status === 'RESOLVED' ? 'badge-blue' : 'badge-gray'
              )}>
                {market.status}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-4 text-sm text-surface-400">
              <span>{market.stats?.totalTrades || 0} trades</span>
              <span>{market.stats?.totalPositions || 0} positions</span>
              {market.endTime && (
                <span>
                  Ends: {new Date(market.endTime).toLocaleDateString()}
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>

      {markets.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-surface-400">
            No markets found. Markets will appear here after syncing trades.
          </p>
        </div>
      )}
    </div>
  );
}
