/**
 * Market Sync Service
 * 
 * Updates market metadata and status from external sources.
 */

import { prisma } from '@/lib/db';
import { getProvider } from '@/lib/providers';
import type { MarketStatus, Prisma } from '@prisma/client';

interface MarketSyncResult {
  marketsUpdated: number;
  marketsResolved: number;
  errors: string[];
}

/**
 * Sync all markets in database with external source
 */
export async function syncMarkets(): Promise<MarketSyncResult> {
  const result: MarketSyncResult = {
    marketsUpdated: 0,
    marketsResolved: 0,
    errors: [],
  };

  try {
    const provider = getProvider();

    // Get all markets from DB
    const markets = await prisma.market.findMany();
    
    if (markets.length === 0) {
      return result;
    }

    // Fetch updates from provider
    const conditionIds = markets.map(m => m.conditionId);
    const marketData = await provider.markets.fetchMarkets(conditionIds);

    // Update each market
    for (const market of markets) {
      const data = marketData.get(market.conditionId);
      if (!data) continue;

      try {
        const wasResolved = market.status !== 'RESOLVED';
        const isNowResolved = data.status === 'RESOLVED';

        await prisma.market.update({
          where: { id: market.id },
          data: {
            title: data.title,
            description: data.description,
            status: data.status as MarketStatus,
            outcomes: data.outcomes as unknown as Prisma.InputJsonValue,
            endTime: data.endTime,
            resolutionPrice: data.resolutionPrice as unknown as Prisma.InputJsonValue,
          },
        });

        result.marketsUpdated++;

        if (wasResolved && isNowResolved) {
          result.marketsResolved++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`Market ${market.conditionId}: ${message}`);
      }
    }

    // Update sync status
    await prisma.syncStatus.upsert({
      where: { jobType: 'sync_markets' },
      update: {
        lastRunAt: new Date(),
        lastSuccess: result.errors.length === 0 ? new Date() : undefined,
        lastError: result.errors.length > 0 ? result.errors.join('; ') : null,
        itemsProcessed: result.marketsUpdated,
        isRunning: false,
      },
      create: {
        jobType: 'sync_markets',
        lastRunAt: new Date(),
        lastSuccess: result.errors.length === 0 ? new Date() : null,
        lastError: result.errors.length > 0 ? result.errors.join('; ') : null,
        itemsProcessed: result.marketsUpdated,
        isRunning: false,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Sync failed: ${message}`);
  }

  return result;
}

/**
 * Get all markets with optional filtering
 */
export async function getMarkets(options?: {
  status?: MarketStatus;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const { status, search, limit = 50, offset = 0 } = options || {};

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
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.market.count({ where }),
  ]);

  return { markets, total };
}

/**
 * Get a single market by condition ID
 */
export async function getMarketByConditionId(conditionId: string) {
  return prisma.market.findUnique({
    where: { conditionId },
    include: {
      positions: {
        include: { wallet: true },
      },
      trades: {
        orderBy: { blockTime: 'desc' },
        take: 100,
        include: { wallet: true },
      },
    },
  });
}
