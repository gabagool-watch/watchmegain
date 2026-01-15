/**
 * Wallet Trades API
 * GET /api/wallets/:id/trades - Get trades for a wallet
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const conditionId = searchParams.get('conditionId');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    const where: Prisma.TradeWhereInput = {
      walletId: params.id,
    };

    if (from || to) {
      const blockTimeFilter: Prisma.DateTimeFilter = {};
      if (from) blockTimeFilter.gte = new Date(from);
      if (to) blockTimeFilter.lte = new Date(to);
      where.blockTime = blockTimeFilter;
    }
    if (conditionId) {
      where.market = { conditionId };
    }

    const [trades, total] = await Promise.all([
      prisma.trade.findMany({
        where,
        include: { market: true },
        orderBy: { blockTime: 'desc' },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      prisma.trade.count({ where }),
    ]);

    return NextResponse.json({
      data: trades,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Failed to fetch trades:', error);
    return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 500 });
  }
}
