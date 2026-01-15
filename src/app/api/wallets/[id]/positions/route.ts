/**
 * Wallet Positions API
 * GET /api/wallets/:id/positions - Get positions for a wallet
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { PositionStatus, Prisma } from '@prisma/client';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as PositionStatus | null;

    const where: Prisma.PositionWhereInput = {
      walletId: params.id,
    };

    if (status) {
      where.status = status;
    }

    const positions = await prisma.position.findMany({
      where,
      include: { market: true },
      orderBy: { lastUpdated: 'desc' },
    });

    return NextResponse.json(positions);
  } catch (error) {
    console.error('Failed to fetch positions:', error);
    return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
  }
}
