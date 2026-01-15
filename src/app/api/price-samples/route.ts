/**
 * API endpoint for price samples data
 * 
 * GET /api/price-samples
 * Query params:
 * - from: ISO timestamp (default: last hour)
 * - to: ISO timestamp (default: now)
 * - source: BINANCE | POLYMARKET
 * - symbol: BTCUSDT | POLY_BTC_15M_UP | POLY_BTC_15M_DOWN
 * - limit: number (default: 1000)
 * - sources: comma-separated list (e.g. BINANCE,CHAINLINK,POLYMARKET)
 * - symbols: comma-separated list
 * - order: asc | desc (default: desc)
 * - includeExtraJson: true | false (default: false)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const source = searchParams.get('source');
    const symbol = searchParams.get('symbol');
    const side = searchParams.get('side');
    const sources = searchParams.get('sources');
    const symbols = searchParams.get('symbols');
    const limit = parseInt(searchParams.get('limit') || '1000', 10);
    const order = (searchParams.get('order') || 'desc').toLowerCase();
    const includeExtraJson = searchParams.get('includeExtraJson') === 'true';

    // Default: last hour
    const defaultFrom = new Date(Date.now() - 60 * 60 * 1000);
    const defaultTo = new Date();

    const where: any = {
      observedAt: {
        gte: from ? new Date(from) : defaultFrom,
        lte: to ? new Date(to) : defaultTo,
      },
    };

    if (source) {
      where.source = source;
    }

    if (symbol) {
      where.symbol = symbol;
    }

    if (side) {
      where.side = side;
    }

    if (sources) {
      where.source = { in: sources.split(',').map((s) => s.trim()).filter(Boolean) };
    }

    if (symbols) {
      where.symbol = { in: symbols.split(',').map((s) => s.trim()).filter(Boolean) };
    }

    const samples = await prisma.priceSample.findMany({
      where,
      orderBy: {
        observedAt: order === 'asc' ? 'asc' : 'desc',
      },
      take: limit,
      // Avoid shipping big JSON blobs unless explicitly needed
      select: includeExtraJson
        ? undefined
        : {
            id: true,
            source: true,
            symbol: true,
            marketSlug: true,
            conditionId: true,
            assetId: true,
            side: true,
            price: true,
            isBestBid: true,
            isBestAsk: true,
            observedAt: true,
            createdAt: true,
          },
    });

    // Calculate statistics
    const stats = {
      total: samples.length,
      bySource: {} as Record<string, number>,
      bySymbol: {} as Record<string, number>,
      timeRange: {
        // Works for both asc/desc
        from: samples.length ? (order === 'asc' ? samples[0].observedAt : samples[samples.length - 1].observedAt) : null,
        to: samples.length ? (order === 'asc' ? samples[samples.length - 1].observedAt : samples[0].observedAt) : null,
      },
    };

    samples.forEach((s) => {
      stats.bySource[s.source] = (stats.bySource[s.source] || 0) + 1;
      stats.bySymbol[s.symbol] = (stats.bySymbol[s.symbol] || 0) + 1;
    });

    return NextResponse.json({
      samples,
      stats,
    });
  } catch (error) {
    console.error('Failed to fetch price samples:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch price samples' },
      { status: 500 }
    );
  }
}
