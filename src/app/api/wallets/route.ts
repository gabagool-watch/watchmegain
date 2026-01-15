/**
 * Wallets API
 * GET /api/wallets - List all tracked wallets with stats
 * POST /api/wallets - Add a new tracked wallet
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const CreateWalletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  alias: z.string().optional(),
});

export async function GET() {
  try {
    const wallets = await prisma.trackedWallet.findMany({
      include: {
        positions: true,
        trades: {
          select: { cost: true },
        },
        _count: {
          select: {
            trades: true,
            positions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate stats for each wallet
    const walletsWithStats = wallets.map((wallet) => {
      const totalRealizedPnl = wallet.positions.reduce((sum, p) => sum + p.realizedPnl, 0);
      const totalUnrealizedPnl = wallet.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const totalVolume = wallet.trades.reduce((sum, t) => sum + t.cost, 0);
      const openPositions = wallet.positions.filter((p) => p.status === 'OPEN').length;

      return {
        id: wallet.id,
        address: wallet.address,
        alias: wallet.alias,
        createdAt: wallet.createdAt,
        stats: {
          totalRealizedPnl,
          totalUnrealizedPnl,
          totalPnl: totalRealizedPnl + totalUnrealizedPnl,
          totalVolume,
          totalTrades: wallet._count.trades,
          openPositions,
          closedPositions: wallet._count.positions - openPositions,
        },
      };
    });

    return NextResponse.json(walletsWithStats);
  } catch (error) {
    console.error('Failed to fetch wallets:', error);
    return NextResponse.json({ error: 'Failed to fetch wallets' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = CreateWalletSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const { address, alias } = validation.data;

    // Check if wallet already exists
    const existing = await prisma.trackedWallet.findUnique({
      where: { address: address.toLowerCase() },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'Wallet already exists', wallet: existing },
        { status: 409 }
      );
    }

    const wallet = await prisma.trackedWallet.create({
      data: {
        address: address.toLowerCase(),
        alias,
      },
    });

    return NextResponse.json(wallet, { status: 201 });
  } catch (error) {
    console.error('Failed to create wallet:', error);
    return NextResponse.json({ error: 'Failed to create wallet' }, { status: 500 });
  }
}
