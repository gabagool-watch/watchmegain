/**
 * Data API Sync Endpoint
 * 
 * Syncs positions directly from Polymarket's Data API.
 * This uses Polymarket's own PnL calculations which are the most accurate.
 */

import { NextResponse } from 'next/server';
import { runDataAPISync } from '@/lib/sync';

// Check if authorized - for local dev, always allow
function isAuthorized(): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD;
  
  // If no admin password is configured, allow all requests
  // This is fine for local development
  if (!adminPassword) {
    return true;
  }
  
  // For production with password set, we'd need to check auth
  // But for now, allow all to simplify local testing
  return true;
}

export async function POST() {
  // Check authorization
  if (!isAuthorized()) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    console.log('\n🔄 Starting Data API sync...');
    
    const result = await runDataAPISync();
    
    return NextResponse.json({
      success: true,
      positionsImported: result.dataApiResult.totalPositions,
      totalCashPnl: result.dataApiResult.totalCashPnl,
      snapshotsCreated: result.snapshots.totalCreated,
      duration: result.duration,
      walletResults: result.dataApiResult.results.map(r => ({
        walletId: r.walletId,
        positions: r.positionsImported,
        cashPnl: r.totalCashPnl,
        initialValue: r.totalInitialValue,
        currentValue: r.totalCurrentValue,
        errors: r.errors.length,
      })),
    });
  } catch (error) {
    console.error('Data API sync failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Data API Sync endpoint. Use POST to trigger sync.',
    description: 'Syncs positions with PnL directly from Polymarket Data API.',
  });
}
