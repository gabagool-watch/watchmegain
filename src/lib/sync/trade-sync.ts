/**
 * Trade Sync Service
 * 
 * Fetches and stores trades for tracked wallets.
 * Idempotent: uses tx_hash + log_index as unique constraint.
 * Reorg-safe: re-fetches trades within lookback window.
 */

import { prisma } from '@/lib/db';
import { getProvider } from '@/lib/providers';
import type { RawTrade } from '@/lib/providers/types';
import type { TradeSide } from '@prisma/client';

const REORG_LOOKBACK_MS = (parseInt(process.env.REORG_LOOKBACK_MINUTES || '120') || 120) * 60 * 1000;
// For initial sync, go back 90 days
const INITIAL_SYNC_DAYS = parseInt(process.env.INITIAL_SYNC_DAYS || '90') || 90;

interface SyncResult {
  walletId: string;
  address: string;
  tradesFound: number;
  tradesNew: number;
  errors: string[];
}

/**
 * Sync trades for a single wallet
 */
export async function syncWalletTrades(
  walletId: string,
  address: string,
  from?: Date,
  to?: Date
): Promise<SyncResult> {
  const provider = getProvider();
  const result: SyncResult = {
    walletId,
    address,
    tradesFound: 0,
    tradesNew: 0,
    errors: [],
  };

  try {
    // Check if this wallet has any existing trades (for initial sync detection)
    const existingTradeCount = await prisma.trade.count({
      where: { walletId },
    });
    const isInitialSync = existingTradeCount === 0;

    // Default time range: lookback to now
    // For initial sync, go back 90 days; for subsequent syncs, use REORG_LOOKBACK
    const toDate = to || new Date();
    const lookbackMs = isInitialSync 
      ? INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000 
      : REORG_LOOKBACK_MS;
    const fromDate = from || new Date(toDate.getTime() - lookbackMs);

    console.log(`Sync for ${address}: ${isInitialSync ? 'INITIAL' : 'incremental'}, range: ${fromDate.toISOString()} to ${toDate.toISOString()}`);

    // Fetch trades from provider
    const rawTrades = await provider.trades.fetchTrades(address, fromDate, toDate);
    result.tradesFound = rawTrades.length;
    console.log(`Found ${rawTrades.length} trades for ${address}`);

    if (rawTrades.length === 0) {
      return result;
    }

    // Build map of conditionId -> marketTitle from trade data
    const marketTitles = new Map<string, string>();
    for (const trade of rawTrades) {
      if (trade.marketTitle && !marketTitles.has(trade.conditionId)) {
        marketTitles.set(trade.conditionId, trade.marketTitle);
      }
    }

    // Get or create markets for these trades
    const conditionIds = Array.from(new Set(rawTrades.map(t => t.conditionId)));
    const marketMap = await ensureMarketsExist(conditionIds, marketTitles);

    // Upsert trades (idempotent)
    for (const rawTrade of rawTrades) {
      const marketId = marketMap.get(rawTrade.conditionId);
      if (!marketId) {
        result.errors.push(`Market not found for condition: ${rawTrade.conditionId}`);
        continue;
      }

      try {
        const existingTrade = await prisma.trade.findUnique({
          where: {
            txHash_logIndex: {
              txHash: rawTrade.txHash,
              logIndex: rawTrade.logIndex,
            },
          },
        });

        if (!existingTrade) {
          await prisma.trade.create({
            data: {
              walletId,
              marketId,
              txHash: rawTrade.txHash,
              logIndex: rawTrade.logIndex,
              blockTime: rawTrade.blockTime,
              blockNumber: rawTrade.blockNumber,
              outcome: rawTrade.outcome,
              side: rawTrade.side as TradeSide,
              price: rawTrade.price,
              size: rawTrade.size,
              cost: rawTrade.size * rawTrade.price + (rawTrade.side === 'BUY' ? rawTrade.fee : -rawTrade.fee),
              fee: rawTrade.fee,
            },
          });
          result.tradesNew++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Failed to upsert trade ${rawTrade.txHash}: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Sync failed: ${message}`);
  }

  return result;
}

/**
 * Sync trades for all tracked wallets
 */
export async function syncAllWalletsTrades(): Promise<{
  results: SyncResult[];
  totalFound: number;
  totalNew: number;
  totalErrors: number;
}> {
  const wallets = await prisma.trackedWallet.findMany();
  const results: SyncResult[] = [];
  let totalFound = 0;
  let totalNew = 0;
  let totalErrors = 0;

  console.log(`\n${'#'.repeat(60)}`);
  console.log(`SYNCING TRADES FOR ${wallets.length} WALLET(S)`);
  console.log(`${'#'.repeat(60)}\n`);

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    console.log(`\n[Wallet ${i + 1}/${wallets.length}] ${wallet.alias || wallet.address.slice(0, 10)}...`);
    
    const result = await syncWalletTrades(wallet.id, wallet.address);
    results.push(result);
    totalFound += result.tradesFound;
    totalNew += result.tradesNew;
    totalErrors += result.errors.length;

    console.log(`[Wallet ${i + 1}/${wallets.length}] Found: ${result.tradesFound}, New: ${result.tradesNew}, Errors: ${result.errors.length}`);

    // Small delay between wallets to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n${'#'.repeat(60)}`);
  console.log(`SYNC COMPLETE: Found ${totalFound} trades, ${totalNew} new, ${totalErrors} errors`);
  console.log(`${'#'.repeat(60)}\n`);

  // Update sync status
  await prisma.syncStatus.upsert({
    where: { jobType: 'sync_trades' },
    update: {
      lastRunAt: new Date(),
      lastSuccess: totalErrors === 0 ? new Date() : undefined,
      lastError: totalErrors > 0 ? `${totalErrors} errors occurred` : null,
      itemsProcessed: totalNew,
      isRunning: false,
    },
    create: {
      jobType: 'sync_trades',
      lastRunAt: new Date(),
      lastSuccess: totalErrors === 0 ? new Date() : null,
      lastError: totalErrors > 0 ? `${totalErrors} errors occurred` : null,
      itemsProcessed: totalNew,
      isRunning: false,
    },
  });

  return { results, totalFound, totalNew, totalErrors };
}

/**
 * Ensure markets exist in DB, create if missing
 * Creates placeholder markets if API data is unavailable
 * @param conditionIds - List of market condition IDs to ensure exist
 * @param marketTitles - Optional map of conditionId -> title from trade data
 */
async function ensureMarketsExist(
  conditionIds: string[],
  marketTitles?: Map<string, string>
): Promise<Map<string, string>> {
  const marketMap = new Map<string, string>();

  // Check existing markets
  const existingMarkets = await prisma.market.findMany({
    where: { conditionId: { in: conditionIds } },
    select: { id: true, conditionId: true },
  });

  for (const market of existingMarkets) {
    marketMap.set(market.conditionId, market.id);
  }

  // Find missing markets
  const missingIds = conditionIds.filter(id => !marketMap.has(id));
  if (missingIds.length === 0) {
    return marketMap;
  }

  console.log(`Creating ${missingIds.length} missing markets...`);
  
  // Create markets using titles from trade data (no need to call Gamma API)
  for (const conditionId of missingIds) {
    const title = marketTitles?.get(conditionId) || `Market ${conditionId.slice(0, 10)}...`;
    
    try {
      const market = await prisma.market.create({
        data: {
          conditionId,
          title,
          description: '',
          status: 'OPEN',
          outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
        },
      });
      marketMap.set(conditionId, market.id);
      console.log(`Created market: ${title.slice(0, 50)}...`);
    } catch (error) {
      // Market might have been created by another process
      const existing = await prisma.market.findUnique({
        where: { conditionId },
        select: { id: true },
      });
      if (existing) {
        marketMap.set(conditionId, existing.id);
      } else {
        console.error(`Failed to create market ${conditionId}:`, error);
      }
    }
  }

  return marketMap;
}
