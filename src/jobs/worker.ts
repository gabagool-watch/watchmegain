/**
 * Background Worker for Sync Jobs
 * 
 * Runs periodic sync jobs using node-cron.
 * Can be replaced with BullMQ for more robust job handling.
 */

import { runFullSync, createAllSnapshots } from '@/lib/sync';

const SYNC_INTERVAL_MS = (parseInt(process.env.SYNC_INTERVAL_SECONDS || '120') || 120) * 1000;
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let syncTimer: NodeJS.Timeout | null = null;
let snapshotTimer: NodeJS.Timeout | null = null;

async function syncJob() {
  console.log(`[${new Date().toISOString()}] Starting sync job...`);
  try {
    const result = await runFullSync();
    console.log(`[${new Date().toISOString()}] Sync completed in ${result.duration}ms`);
    console.log(`  - Trades: ${result.trades.totalNew} new`);
    console.log(`  - Positions: ${result.positions.totalUpdated} updated, ${result.positions.totalCreated} created`);
    console.log(`  - Markets: ${result.markets.marketsUpdated} updated`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Sync failed:`, error);
  }
}

async function snapshotJob() {
  console.log(`[${new Date().toISOString()}] Creating snapshots...`);
  try {
    const result = await createAllSnapshots();
    console.log(`[${new Date().toISOString()}] Created ${result.totalCreated} snapshots`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Snapshot creation failed:`, error);
  }
}

function startWorker() {
  console.log('Starting PnL Tracker Worker...');
  console.log(`Sync interval: ${SYNC_INTERVAL_MS / 1000}s`);
  console.log(`Snapshot interval: ${SNAPSHOT_INTERVAL_MS / 1000}s`);

  // Run immediately on start
  syncJob();

  // Schedule periodic jobs
  syncTimer = setInterval(syncJob, SYNC_INTERVAL_MS);
  snapshotTimer = setInterval(snapshotJob, SNAPSHOT_INTERVAL_MS);

  console.log('Worker started. Press Ctrl+C to stop.');
}

function stopWorker() {
  console.log('Stopping worker...');
  if (syncTimer) clearInterval(syncTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', stopWorker);
process.on('SIGTERM', stopWorker);

// Start the worker
startWorker();
