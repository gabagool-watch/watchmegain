/**
 * API endpoint for lag analysis
 * 
 * GET /api/price-samples/lag
 * Calculates the lag between Binance and Polymarket prices
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    // Default: last hour
    const defaultFrom = new Date(Date.now() - 60 * 60 * 1000);
    const defaultTo = new Date();

    const startTime = from ? new Date(from) : defaultFrom;
    const endTime = to ? new Date(to) : defaultTo;

    // Get Binance samples (BTCUSDT)
    const binanceSamples = await prisma.priceSample.findMany({
      where: {
        source: 'BINANCE',
        symbol: 'BTCUSDT',
        observedAt: {
          gte: startTime,
          lte: endTime,
        },
      },
      orderBy: {
        observedAt: 'asc',
      },
    });

    // Get Polymarket samples
    const polySamples = await prisma.priceSample.findMany({
      where: {
        source: 'POLYMARKET',
        symbol: {
          in: ['POLY_BTC_15M_UP', 'POLY_BTC_15M_DOWN'],
        },
        observedAt: {
          gte: startTime,
          lte: endTime,
        },
      },
      orderBy: {
        observedAt: 'asc',
      },
    });

    // Calculate lag with two-pointer (both arrays are sorted asc)
    const lagData: Array<{
      timestamp: Date;
      polyPrice: number;
      polySymbol: string;
      binancePrice: number;
      lagMs: number;
      priceDiff: number;
    }> = [];

    if (binanceSamples.length > 0) {
      let i = 0; // pointer into binanceSamples

      for (const polySample of polySamples) {
        const t = polySample.observedAt.getTime();

        while (i + 1 < binanceSamples.length && binanceSamples[i + 1].observedAt.getTime() <= t) {
          i++;
        }

        const prev = binanceSamples[i];
        const next = i + 1 < binanceSamples.length ? binanceSamples[i + 1] : null;

        let closest = prev;
        let minDiff = Math.abs(t - prev.observedAt.getTime());
        if (next) {
          const d2 = Math.abs(t - next.observedAt.getTime());
          if (d2 < minDiff) {
            closest = next;
            minDiff = d2;
          }
        }

        if (closest && minDiff < 60_000) {
          const lagMs = polySample.observedAt.getTime() - closest.observedAt.getTime();
          const priceDiff = Math.abs(polySample.price - closest.price);

          lagData.push({
            timestamp: polySample.observedAt,
            polyPrice: polySample.price,
            polySymbol: polySample.symbol,
            binancePrice: closest.price,
            lagMs,
            priceDiff,
          });
        }
      }
    }

    // Calculate statistics
    const lags = lagData.map((d) => d.lagMs);
    const avgLag = lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;
    const minLag = lags.length > 0 ? Math.min(...lags) : 0;
    const maxLag = lags.length > 0 ? Math.max(...lags) : 0;
    const medianLag =
      lags.length > 0
        ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)]
        : 0;

    return NextResponse.json({
      lagData,
      stats: {
        total: lagData.length,
        avgLagMs: Math.round(avgLag),
        minLagMs: minLag,
        maxLagMs: maxLag,
        medianLagMs: medianLag,
        timeRange: {
          from: lagData[0]?.timestamp || null,
          to: lagData[lagData.length - 1]?.timestamp || null,
        },
      },
    });
  } catch (error) {
    console.error('Failed to calculate lag:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to calculate lag' },
      { status: 500 }
    );
  }
}
