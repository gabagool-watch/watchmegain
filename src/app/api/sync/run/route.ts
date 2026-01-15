/**
 * Run Sync API
 * POST /api/sync/run - Trigger a full sync manually
 */

import { NextRequest, NextResponse } from 'next/server';
import { runFullSync } from '@/lib/sync';

// Basic admin auth check
function isAuthorized(request: NextRequest): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD;

  // Allow if no password set or password is default "changeme"
  if (!adminPassword || adminPassword === 'changeme') {
    return true;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;

  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer') return false;

  return token === adminPassword;
}

export async function POST(request: NextRequest) {
  // Check authorization
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('Starting manual sync...');
    const result = await runFullSync();

    return NextResponse.json({
      success: true,
      result: {
        duration: result.duration,
        tradesFound: result.trades.totalFound,
        tradesNew: result.trades.totalNew,
        positionsUpdated: result.positions.totalUpdated,
        positionsCreated: result.positions.totalCreated,
        marketsUpdated: result.markets.marketsUpdated,
        snapshotsCreated: result.snapshots.totalCreated,
        errors: {
          trades: result.trades.totalErrors,
          positions: result.positions.totalErrors,
          markets: result.markets.errors.length,
          snapshots: result.snapshots.totalErrors,
        },
      },
    });
  } catch (error) {
    console.error('Sync failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
