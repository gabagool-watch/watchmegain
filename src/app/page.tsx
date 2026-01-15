import { prisma } from '@/lib/db';
import { TradingDashboard } from '@/components/TradingDashboard';

async function getDashboardData() {
  try {
    // Get all wallets
    const wallets = await prisma.trackedWallet.findMany();
    
    if (wallets.length === 0) {
      return null;
    }

    // Get all positions with markets (including endTime)
    const positions = await prisma.position.findMany({
      include: { market: true },
      orderBy: { lastUpdated: 'desc' },
    });

    // Calculate totals
    let totalPnl = 0;
    let totalValue = 0;
    let totalCost = 0;

    const positionData = positions.map(p => {
      const pnl = p.realizedPnl + p.unrealizedPnl;
      const currentValue = p.shares * p.avgEntryPrice; // Would use live price
      const cost = p.totalCost;
      
      totalPnl += pnl;
      totalValue += currentValue;
      totalCost += cost;

      // Get outcome name from market outcomes array
      const rawOutcomes = (p.market.outcomes as any) as any[];
      const entry = Array.isArray(rawOutcomes) ? rawOutcomes[p.outcome] : null;
      const outcomeName =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object' && typeof entry.name === 'string'
            ? entry.name
            : (p.outcome === 0 ? 'Yes' : 'No');

      return {
        id: p.id,
        market: p.market.title,
        marketEndTime: p.market.endTime?.toISOString(),
        outcome: p.outcome,
        outcomeName, // Add outcome name
        shares: p.shares,
        avgPrice: p.avgEntryPrice,
        currentPrice: p.avgEntryPrice, // Would be live price
        pnl,
        pnlPercent: cost > 0 ? (pnl / cost) * 100 : 0,
      };
    });

    return {
      positions: positionData,
      walletAddress: wallets[0]?.address || '',
      totalPnl,
      totalValue,
      totalCost,
    };
  } catch (error) {
    console.error('Failed to fetch dashboard data:', error);
    return null;
  }
}

export default async function DashboardPage() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-100 mb-2">No Data Yet</h1>
          <p className="text-slate-400 mb-4">Add a wallet and run a sync to see your positions.</p>
          <a href="/admin" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors">
            Go to Admin
          </a>
        </div>
      </div>
    );
  }

  return <TradingDashboard data={data} />;
}
