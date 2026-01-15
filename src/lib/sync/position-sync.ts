/**
 * Position Sync Service
 * 
 * Recomputes positions from trades using the PnL engine.
 * Should be run after trade sync to keep positions up to date.
 */

import { prisma } from '@/lib/db';
import { getProvider } from '@/lib/providers';
import {
  createEmptyPosition,
  applyTrade,
  calculateUnrealizedPnl,
  resolvePosition,
  type PositionState,
} from '@/lib/pnl-engine';
import type { Trade, Market, PositionStatus } from '@prisma/client';

interface RecomputeResult {
  walletId: string;
  positionsUpdated: number;
  positionsCreated: number;
  errors: string[];
}

/**
 * Recompute all positions for a single wallet
 */
export async function recomputeWalletPositions(walletId: string): Promise<RecomputeResult> {
  const result: RecomputeResult = {
    walletId,
    positionsUpdated: 0,
    positionsCreated: 0,
    errors: [],
  };

  try {
    // Get all trades for this wallet, ordered by time and log index
    const trades = await prisma.trade.findMany({
      where: { walletId },
      include: { market: true },
      orderBy: [
        { blockTime: 'asc' },
        { blockNumber: 'asc' },
        { logIndex: 'asc' },
      ],
    });

    if (trades.length === 0) {
      return result;
    }

    // Group trades by market + outcome
    const tradeGroups = new Map<string, { trades: Trade[]; market: Market }>();
    
    for (const trade of trades) {
      const key = `${trade.marketId}:${trade.outcome}`;
      const existing = tradeGroups.get(key);
      if (existing) {
        existing.trades.push(trade);
      } else {
        tradeGroups.set(key, { trades: [trade], market: trade.market });
      }
    }

    // Get current prices for unrealized PnL
    const provider = getProvider();
    const priceCache = new Map<string, Map<number, number>>();

    // Compute position for each group
    for (const [key, { trades: groupTrades, market }] of Array.from(tradeGroups.entries())) {
      try {
        // Replay trades to get position state
        let positionState = createEmptyPosition();
        
        for (const trade of groupTrades) {
          positionState = applyTrade(positionState, {
            id: trade.id,
            walletId: trade.walletId,
            marketId: trade.marketId,
            txHash: trade.txHash,
            logIndex: trade.logIndex,
            blockTime: trade.blockTime,
            blockNumber: trade.blockNumber,
            outcome: trade.outcome,
            side: trade.side,
            price: trade.price,
            size: trade.size,
            cost: trade.cost,
            fee: trade.fee,
          });
        }

        // Get mark price for unrealized PnL
        let markPrice = 0;
        
        if (market.status === 'RESOLVED' && market.resolutionPrice) {
          const resolution = market.resolutionPrice as Record<string, number>;
          markPrice = resolution[groupTrades[0].outcome.toString()] ?? 0;
          
          // Resolve the position
          positionState = resolvePosition(positionState, markPrice);
        } else {
          // Try to get cached prices or fetch
          if (!priceCache.has(market.conditionId)) {
            try {
              const prices = await provider.prices.getMarketPrices(market.conditionId);
              const priceMap = new Map<number, number>();
              for (const [outcome, priceData] of Array.from(prices.entries())) {
                priceMap.set(outcome, priceData.price);
              }
              priceCache.set(market.conditionId, priceMap);
            } catch {
              // If price fetch fails, use empty map
              priceCache.set(market.conditionId, new Map());
            }
          }
          
          markPrice = priceCache.get(market.conditionId)?.get(groupTrades[0].outcome) ?? 0;
        }

        // If we couldn't get a mark price, use avg entry price as fallback
        // This means unrealized PnL = 0 for positions without price data
        // This is better than showing massive fake losses
        if (markPrice === 0 && positionState.shares > 0) {
          markPrice = positionState.avgEntryPrice;
        }

        const unrealizedPnl = calculateUnrealizedPnl(positionState, markPrice);
        const status: PositionStatus = positionState.shares > 0.001 ? 'OPEN' : 'CLOSED';

        // Upsert position
        const existing = await prisma.position.findUnique({
          where: {
            walletId_marketId_outcome: {
              walletId,
              marketId: groupTrades[0].marketId,
              outcome: groupTrades[0].outcome,
            },
          },
        });

        if (existing) {
          await prisma.position.update({
            where: { id: existing.id },
            data: {
              shares: positionState.shares,
              avgEntryPrice: positionState.avgEntryPrice,
              realizedPnl: positionState.realizedPnl,
              unrealizedPnl,
              totalCost: positionState.totalCost,
              totalFees: positionState.totalFees,
              status,
              lastUpdated: new Date(),
            },
          });
          result.positionsUpdated++;
        } else {
          await prisma.position.create({
            data: {
              walletId,
              marketId: groupTrades[0].marketId,
              outcome: groupTrades[0].outcome,
              shares: positionState.shares,
              avgEntryPrice: positionState.avgEntryPrice,
              realizedPnl: positionState.realizedPnl,
              unrealizedPnl,
              totalCost: positionState.totalCost,
              totalFees: positionState.totalFees,
              status,
            },
          });
          result.positionsCreated++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Position ${key}: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Wallet ${walletId}: ${message}`);
  }

  return result;
}

/**
 * Recompute positions for all tracked wallets
 */
export async function recomputeAllPositions(): Promise<{
  results: RecomputeResult[];
  totalUpdated: number;
  totalCreated: number;
  totalErrors: number;
}> {
  const wallets = await prisma.trackedWallet.findMany();
  const results: RecomputeResult[] = [];
  let totalUpdated = 0;
  let totalCreated = 0;
  let totalErrors = 0;

  for (const wallet of wallets) {
    const result = await recomputeWalletPositions(wallet.id);
    results.push(result);
    totalUpdated += result.positionsUpdated;
    totalCreated += result.positionsCreated;
    totalErrors += result.errors.length;
  }

  // Update sync status
  await prisma.syncStatus.upsert({
    where: { jobType: 'recompute_positions' },
    update: {
      lastRunAt: new Date(),
      lastSuccess: totalErrors === 0 ? new Date() : undefined,
      lastError: totalErrors > 0 ? `${totalErrors} errors occurred` : null,
      itemsProcessed: totalUpdated + totalCreated,
      isRunning: false,
    },
    create: {
      jobType: 'recompute_positions',
      lastRunAt: new Date(),
      lastSuccess: totalErrors === 0 ? new Date() : null,
      lastError: totalErrors > 0 ? `${totalErrors} errors occurred` : null,
      itemsProcessed: totalUpdated + totalCreated,
      isRunning: false,
    },
  });

  return { results, totalUpdated, totalCreated, totalErrors };
}
