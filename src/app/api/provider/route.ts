/**
 * Provider Info API
 * GET /api/provider - Get current data provider info
 */

import { NextResponse } from 'next/server';
import { getProvider, getProviderType } from '@/lib/providers';

export async function GET() {
  try {
    const provider = getProvider();
    const providerType = getProviderType();

    return NextResponse.json({
      type: providerType,
      sources: {
        trades: provider.trades.getName(),
        markets: provider.markets.getName(),
        prices: provider.prices.getName(),
      },
      config: {
        goldsky: {
          activity: process.env.GOLDSKY_ACTIVITY_ENDPOINT ? 'configured' : 'default',
          positions: process.env.GOLDSKY_POSITIONS_ENDPOINT ? 'configured' : 'default',
        },
        gamma: process.env.GAMMA_MARKETS_API ? 'configured' : 'default',
        clob: process.env.POLYMARKET_CLOB_API ? 'configured' : 'default',
        rateLimit: parseInt(process.env.API_RATE_LIMIT_MS || '100'),
        maxRetries: parseInt(process.env.API_MAX_RETRIES || '3'),
      },
    });
  } catch (error) {
    console.error('Failed to get provider info:', error);
    return NextResponse.json({ error: 'Failed to get provider info' }, { status: 500 });
  }
}
