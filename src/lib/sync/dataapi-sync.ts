/**
 * Data API Sync Service
 * 
 * Imports positions directly from Polymarket's Data API.
 * This uses Polymarket's own PnL calculations which are the most accurate.
 */

import { prisma } from '@/lib/db';
import { getProvider } from '@/lib/providers';
import type { PositionStatus } from '@prisma/client';

interface DataApiSyncResult {
  walletId: string;
  positionsImported: number;
  marketsCreated: number;
  totalCashPnl: number;
  totalInitialValue: number;
  totalCurrentValue: number;
  errors: string[];
}

/**
 * Sync positions from Data API for a single wallet
 */
export async function syncWalletFromDataAPI(walletId: string): Promise<DataApiSyncResult> {
  const result: DataApiSyncResult = {
    walletId,
    positionsImported: 0,
    marketsCreated: 0,
    totalCashPnl: 0,
    totalInitialValue: 0,
    totalCurrentValue: 0,
    errors: [],
  };

  try {
    // Get wallet
    const wallet = await prisma.trackedWallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      result.errors.push(`Wallet ${walletId} not found`);
      return result;
    }

    const provider = getProvider();
    
    if (!provider.positions) {
      result.errors.push('Position source not available');
      return result;
    }

    console.log(`\n📊 Syncing positions from Data API for ${wallet.address}...`);

    // Fetch positions from Data API
    const rawPositions = await provider.positions.fetchPositions(wallet.address);

    if (rawPositions.length === 0) {
      console.log('No positions found');
      return result;
    }

    // Group positions by conditionId to create/update markets
    const conditionIds = Array.from(new Set(rawPositions.map(p => p.conditionId)));
    console.log(`Found ${rawPositions.length} positions across ${conditionIds.length} markets`);

    // Ensure markets exist - use Data API info, don't call Gamma API (rate limits)
    for (const conditionId of conditionIds) {
      const existingMarket = await prisma.market.findUnique({
        where: { conditionId },
      });

      if (!existingMarket) {
        // Get all positions with this conditionId to determine outcome names
        const positionsForMarket = rawPositions.filter(p => p.conditionId === conditionId);
        const pos = positionsForMarket[0];
        
        // Determine outcome names from position data
        const outcomeNames: string[] = ['Yes', 'No']; // Default
        
        // Check if any position has outcomeName
        for (const p of positionsForMarket) {
          if (p.outcomeName) {
            const name = p.outcomeName;
            if (p.outcome === 0) outcomeNames[0] = name;
            if (p.outcome === 1) outcomeNames[1] = name;
          }
        }
        
        // Create market with available data from Data API (no external API call)
        try {
          await prisma.market.create({
            data: {
              conditionId,
              title: pos?.marketQuestion || `Market ${conditionId.slice(0, 16)}...`,
              outcomes: outcomeNames,
              status: 'OPEN',
            },
          });
          result.marketsCreated++;
        } catch (e) {
          // Market might already exist due to race condition, ignore
        }
      }
    }

    // Import positions
    for (const pos of rawPositions) {
      try {
        const market = await prisma.market.findUnique({
          where: { conditionId: pos.conditionId },
        });

        if (!market) {
          result.errors.push(`Market ${pos.conditionId} not found`);
          continue;
        }

        // Determine position status
        const status: PositionStatus = pos.size > 0.001 ? 'OPEN' : 'CLOSED';

        // Calculate unrealized PnL (currentValue - initialValue if open)
        const unrealizedPnl = status === 'OPEN' 
          ? pos.currentValue - pos.initialValue 
          : 0;

        // Cash PnL from Data API is the realized PnL
        const realizedPnl = pos.cashPnl;

        // Upsert position
        await prisma.position.upsert({
          where: {
            walletId_marketId_outcome: {
              walletId,
              marketId: market.id,
              outcome: pos.outcome,
            },
          },
          update: {
            shares: pos.size,
            avgEntryPrice: pos.avgPrice,
            realizedPnl,
            unrealizedPnl,
            totalCost: pos.initialValue,
            totalFees: 0, // Not available from Data API
            status,
            lastUpdated: new Date(),
          },
          create: {
            walletId,
            marketId: market.id,
            outcome: pos.outcome,
            shares: pos.size,
            avgEntryPrice: pos.avgPrice,
            realizedPnl,
            unrealizedPnl,
            totalCost: pos.initialValue,
            totalFees: 0,
            status,
          },
        });

        result.positionsImported++;
        result.totalCashPnl += pos.cashPnl;
        result.totalInitialValue += pos.initialValue;
        result.totalCurrentValue += pos.currentValue;

      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Position ${pos.conditionId}: ${message}`);
      }
    }

    // Update wallet's updated time
    await prisma.trackedWallet.update({
      where: { id: walletId },
      data: { updatedAt: new Date() },
    });

    console.log(`\n✅ Imported ${result.positionsImported} positions`);
    console.log(`   Markets created: ${result.marketsCreated}`);
    console.log(`   Total Cash PnL: $${result.totalCashPnl.toFixed(2)}`);
    console.log(`   Total Initial Value: $${result.totalInitialValue.toFixed(2)}`);
    console.log(`   Total Current Value: $${result.totalCurrentValue.toFixed(2)}`);

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(message);
    console.error('❌ Sync failed:', message);
  }

  return result;
}

/**
 * Sync positions from Data API for all tracked wallets
 */
export async function syncAllWalletsFromDataAPI(): Promise<{
  results: DataApiSyncResult[];
  totalPositions: number;
  totalCashPnl: number;
}> {
  const wallets = await prisma.trackedWallet.findMany();
  const results: DataApiSyncResult[] = [];
  let totalPositions = 0;
  let totalCashPnl = 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`DATA API SYNC - ${wallets.length} wallets`);
  console.log(`${'='.repeat(60)}`);

  for (const wallet of wallets) {
    const result = await syncWalletFromDataAPI(wallet.id);
    results.push(result);
    totalPositions += result.positionsImported;
    totalCashPnl += result.totalCashPnl;
  }

  // Update sync status
  await prisma.syncStatus.upsert({
    where: { jobType: 'dataapi_sync' },
    update: {
      lastRunAt: new Date(),
      lastSuccess: new Date(),
      itemsProcessed: totalPositions,
      isRunning: false,
    },
    create: {
      jobType: 'dataapi_sync',
      lastRunAt: new Date(),
      lastSuccess: new Date(),
      itemsProcessed: totalPositions,
      isRunning: false,
    },
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SYNC COMPLETE`);
  console.log(`Total Positions: ${totalPositions}`);
  console.log(`Total Cash PnL: $${totalCashPnl.toFixed(2)}`);
  console.log(`${'='.repeat(60)}\n`);

  return { results, totalPositions, totalCashPnl };
}
