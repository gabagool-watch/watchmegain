/**
 * Snapshot Sync Service
 * 
 * Creates periodic snapshots of wallet equity and PnL for historical charts.
 */

import { prisma } from '@/lib/db';
import { subDays } from 'date-fns';

interface SnapshotResult {
  walletId: string;
  snapshotCreated: boolean;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  error?: string;
}

/**
 * Create a snapshot for a single wallet
 */
export async function createWalletSnapshot(walletId: string): Promise<SnapshotResult> {
  const result: SnapshotResult = {
    walletId,
    snapshotCreated: false,
    equity: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
  };

  try {
    // Get all positions for this wallet
    const positions = await prisma.position.findMany({
      where: { walletId },
    });

    // Calculate totals
    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;
    let openPositions = 0;

    for (const position of positions) {
      totalRealizedPnl += position.realizedPnl;
      totalUnrealizedPnl += position.unrealizedPnl;
      if (position.status === 'OPEN') {
        openPositions++;
      }
    }

    // Calculate 30-day volume
    const thirtyDaysAgo = subDays(new Date(), 30);
    const volumeResult = await prisma.trade.aggregate({
      where: {
        walletId,
        blockTime: { gte: thirtyDaysAgo },
      },
      _sum: { cost: true },
    });

    const volume30d = volumeResult._sum.cost || 0;

    // Equity = realized + unrealized PnL
    const equity = totalRealizedPnl + totalUnrealizedPnl;

    // Create snapshot
    await prisma.snapshot.create({
      data: {
        walletId,
        equity,
        realizedPnl: totalRealizedPnl,
        unrealizedPnl: totalUnrealizedPnl,
        volume30d,
        openPositions,
      },
    });

    result.snapshotCreated = true;
    result.equity = equity;
    result.realizedPnl = totalRealizedPnl;
    result.unrealizedPnl = totalUnrealizedPnl;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}

/**
 * Create snapshots for all tracked wallets
 */
export async function createAllSnapshots(): Promise<{
  results: SnapshotResult[];
  totalCreated: number;
  totalErrors: number;
}> {
  const wallets = await prisma.trackedWallet.findMany();
  const results: SnapshotResult[] = [];
  let totalCreated = 0;
  let totalErrors = 0;

  for (const wallet of wallets) {
    const result = await createWalletSnapshot(wallet.id);
    results.push(result);
    if (result.snapshotCreated) {
      totalCreated++;
    }
    if (result.error) {
      totalErrors++;
    }
  }

  // Update sync status
  await prisma.syncStatus.upsert({
    where: { jobType: 'create_snapshots' },
    update: {
      lastRunAt: new Date(),
      lastSuccess: totalErrors === 0 ? new Date() : undefined,
      lastError: totalErrors > 0 ? `${totalErrors} errors occurred` : null,
      itemsProcessed: totalCreated,
      isRunning: false,
    },
    create: {
      jobType: 'create_snapshots',
      lastRunAt: new Date(),
      lastSuccess: totalErrors === 0 ? new Date() : null,
      lastError: totalErrors > 0 ? `${totalErrors} errors occurred` : null,
      itemsProcessed: totalCreated,
      isRunning: false,
    },
  });

  return { results, totalCreated, totalErrors };
}

/**
 * Get historical snapshots for a wallet
 */
export async function getWalletSnapshots(
  walletId: string,
  from?: Date,
  to?: Date,
  limit?: number
) {
  return prisma.snapshot.findMany({
    where: {
      walletId,
      timestamp: {
        gte: from,
        lte: to,
      },
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
}
