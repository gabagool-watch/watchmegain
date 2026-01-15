/**
 * Sync Services Index
 * 
 * Exports all sync-related functions.
 */

export * from './trade-sync';
export * from './position-sync';
export * from './snapshot-sync';
export * from './market-sync';
export * from './dataapi-sync';

import { syncAllWalletsTrades } from './trade-sync';
import { recomputeAllPositions } from './position-sync';
import { createAllSnapshots } from './snapshot-sync';
import { syncMarkets } from './market-sync';
import { syncAllWalletsFromDataAPI } from './dataapi-sync';
import { prisma } from '@/lib/db';

/**
 * Run a full sync: trades → positions → snapshots (legacy method)
 */
export async function runFullSync(): Promise<{
  trades: Awaited<ReturnType<typeof syncAllWalletsTrades>>;
  positions: Awaited<ReturnType<typeof recomputeAllPositions>>;
  markets: Awaited<ReturnType<typeof syncMarkets>>;
  snapshots: Awaited<ReturnType<typeof createAllSnapshots>>;
  duration: number;
}> {
  const startTime = Date.now();

  // 1. Sync markets first
  const markets = await syncMarkets();

  // 2. Sync trades
  const trades = await syncAllWalletsTrades();

  // 3. Recompute positions
  const positions = await recomputeAllPositions();

  // 4. Create snapshots
  const snapshots = await createAllSnapshots();

  const duration = Date.now() - startTime;

  return { trades, positions, markets, snapshots, duration };
}

/**
 * Run a quick sync using Data API (recommended - uses Polymarket's PnL calculations)
 */
export async function runDataAPISync(): Promise<{
  dataApiResult: Awaited<ReturnType<typeof syncAllWalletsFromDataAPI>>;
  snapshots: Awaited<ReturnType<typeof createAllSnapshots>>;
  duration: number;
}> {
  const startTime = Date.now();

  // 1. Sync positions directly from Data API (includes PnL)
  const dataApiResult = await syncAllWalletsFromDataAPI();

  // 2. Create snapshots for historical tracking
  const snapshots = await createAllSnapshots();

  const duration = Date.now() - startTime;

  console.log(`\n🚀 Data API Sync completed in ${duration}ms`);
  console.log(`   Positions: ${dataApiResult.totalPositions}`);
  console.log(`   Cash PnL: $${dataApiResult.totalCashPnl.toFixed(2)}`);

  return { dataApiResult, snapshots, duration };
}

/**
 * Get sync status for all jobs
 */
export async function getSyncStatus() {
  return prisma.syncStatus.findMany({
    orderBy: { jobType: 'asc' },
  });
}
