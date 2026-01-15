/**
 * Markets API
 * GET /api/markets - List all markets with optional filtering
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { MarketStatus, Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as MarketStatus | null;
    const search = searchParams.get('search');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');

    const where: Prisma.MarketWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      where.title = { contains: search, mode: 'insensitive' };
    }

    const [markets, total] = await Promise.all([
      prisma.market.findMany({
        where,
        include: {
          _count: {
            select: { trades: true, positions: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      prisma.market.count({ where }),
    ]);

    // Add aggregate stats
    const marketsWithStats = markets.map((market) => ({
      ...market,
      stats: {
        totalTrades: market._count.trades,
        totalPositions: market._count.positions,
      },
    }));

    return NextResponse.json({
      data: marketsWithStats,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Failed to fetch markets:', error);
    return NextResponse.json({ error: 'Failed to fetch markets' }, { status: 500 });
  }
}
