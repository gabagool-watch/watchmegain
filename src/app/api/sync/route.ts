/**
 * Sync API
 * GET /api/sync - Get sync status
 * POST /api/sync/run - Run sync manually (admin)
 */

import { NextResponse } from 'next/server';
import { getSyncStatus } from '@/lib/sync';

export async function GET() {
  try {
    const status = await getSyncStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error('Failed to get sync status:', error);
    return NextResponse.json({ error: 'Failed to get sync status' }, { status: 500 });
  }
}
