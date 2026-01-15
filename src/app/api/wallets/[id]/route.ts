/**
 * Single Wallet API
 * GET /api/wallets/:id - Get wallet details
 * PUT /api/wallets/:id - Update wallet
 * DELETE /api/wallets/:id - Delete wallet
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const UpdateWalletSchema = z.object({
  alias: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const wallet = await prisma.trackedWallet.findUnique({
      where: { id: params.id },
      include: {
        positions: {
          include: { market: true },
          orderBy: { lastUpdated: 'desc' },
        },
        trades: {
          orderBy: { blockTime: 'desc' },
          take: 100,
          include: { market: true },
        },
        snapshots: {
          orderBy: { timestamp: 'desc' },
          take: 100,
        },
        _count: {
          select: { trades: true, positions: true },
        },
      },
    });

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
    }

    // Calculate stats
    const totalRealizedPnl = wallet.positions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalUnrealizedPnl = wallet.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalVolume = wallet.trades.reduce((sum, t) => sum + t.cost, 0);
    const openPositions = wallet.positions.filter((p) => p.status === 'OPEN');
    const closedPositions = wallet.positions.filter((p) => p.status === 'CLOSED');

    return NextResponse.json({
      ...wallet,
      stats: {
        totalRealizedPnl,
        totalUnrealizedPnl,
        totalPnl: totalRealizedPnl + totalUnrealizedPnl,
        totalVolume,
        totalTrades: wallet._count.trades,
        openPositionsCount: openPositions.length,
        closedPositionsCount: closedPositions.length,
      },
      openPositions,
      closedPositions,
    });
  } catch (error) {
    console.error('Failed to fetch wallet:', error);
    return NextResponse.json({ error: 'Failed to fetch wallet' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const validation = UpdateWalletSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const wallet = await prisma.trackedWallet.update({
      where: { id: params.id },
      data: validation.data,
    });

    return NextResponse.json(wallet);
  } catch (error) {
    console.error('Failed to update wallet:', error);
    return NextResponse.json({ error: 'Failed to update wallet' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.trackedWallet.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete wallet:', error);
    return NextResponse.json({ error: 'Failed to delete wallet' }, { status: 500 });
  }
}
