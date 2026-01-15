/**
 * Dashboard Stats API
 * GET /api/stats - Get aggregate statistics for dashboard
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { subDays } from 'date-fns';

export async function GET() {
  try {
    const now = new Date();
    const thirtyDaysAgo = subDays(now, 30);
    const sevenDaysAgo = subDays(now, 7);

    // Get all wallets with their stats
    const wallets = await prisma.trackedWallet.findMany({
      include: {
        positions: true,
        trades: {
          select: { cost: true, blockTime: true },
        },
      },
    });

    // Calculate aggregate stats
    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;
    let totalVolume = 0;
    let volume30d = 0;
    let volume7d = 0;
    let totalTrades = 0;
    let openPositions = 0;

    const leaderboard = wallets.map((wallet) => {
      const realized = wallet.positions.reduce((sum, p) => sum + p.realizedPnl, 0);
      const unrealized = wallet.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const volume = wallet.trades.reduce((sum, t) => sum + t.cost, 0);
      const vol30d = wallet.trades
        .filter((t) => t.blockTime >= thirtyDaysAgo)
        .reduce((sum, t) => sum + t.cost, 0);
      const vol7d = wallet.trades
        .filter((t) => t.blockTime >= sevenDaysAgo)
        .reduce((sum, t) => sum + t.cost, 0);
      const open = wallet.positions.filter((p) => p.status === 'OPEN').length;

      totalRealizedPnl += realized;
      totalUnrealizedPnl += unrealized;
      totalVolume += volume;
      volume30d += vol30d;
      volume7d += vol7d;
      totalTrades += wallet.trades.length;
      openPositions += open;

      return {
        id: wallet.id,
        address: wallet.address,
        alias: wallet.alias,
        totalPnl: realized + unrealized,
        realizedPnl: realized,
        unrealizedPnl: unrealized,
        volume: volume,
        volume30d: vol30d,
        volume7d: vol7d,
        trades: wallet.trades.length,
        openPositions: open,
      };
    });

    // Sort leaderboard by total PnL
    leaderboard.sort((a, b) => b.totalPnl - a.totalPnl);

    // Get top markets by volume
    const topMarkets = await prisma.market.findMany({
      where: { status: 'OPEN' },
      include: {
        trades: {
          select: { cost: true },
        },
        positions: {
          where: { status: 'OPEN' },
          select: { shares: true, avgEntryPrice: true },
        },
      },
      take: 10,
    });

    const marketStats = topMarkets
      .map((market) => ({
        id: market.id,
        conditionId: market.conditionId,
        title: market.title,
        status: market.status,
        volume: market.trades.reduce((sum, t) => sum + t.cost, 0),
        openInterest: market.positions.reduce(
          (sum, p) => sum + p.shares * p.avgEntryPrice,
          0
        ),
      }))
      .sort((a, b) => b.volume - a.volume);

    return NextResponse.json({
      overview: {
        totalRealizedPnl,
        totalUnrealizedPnl,
        totalPnl: totalRealizedPnl + totalUnrealizedPnl,
        totalVolume,
        volume30d,
        volume7d,
        totalTrades,
        openPositions,
        trackedWallets: wallets.length,
      },
      leaderboard,
      topMarkets: marketStats,
    });
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
