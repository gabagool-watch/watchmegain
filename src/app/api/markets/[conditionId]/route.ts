/**
 * Single Market API
 * GET /api/markets/:conditionId - Get market details with positions and trades
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { conditionId: string } }
) {
  try {
    const market = await prisma.market.findUnique({
      where: { conditionId: params.conditionId },
      include: {
        positions: {
          include: { wallet: true },
          orderBy: { shares: 'desc' },
        },
        trades: {
          orderBy: { blockTime: 'desc' },
          take: 100,
          include: { wallet: true },
        },
      },
    });

    if (!market) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    // Calculate market stats
    const totalVolume = market.trades.reduce((sum, t) => sum + t.cost, 0);
    const uniqueTraders = new Set(market.trades.map((t) => t.walletId)).size;
    const openInterest = market.positions
      .filter((p) => p.status === 'OPEN')
      .reduce((sum, p) => sum + p.shares * p.avgEntryPrice, 0);

    return NextResponse.json({
      ...market,
      stats: {
        totalVolume,
        uniqueTraders,
        openInterest,
        totalTrades: market.trades.length,
        totalPositions: market.positions.length,
      },
    });
  } catch (error) {
    console.error('Failed to fetch market:', error);
    return NextResponse.json({ error: 'Failed to fetch market' }, { status: 500 });
  }
}
