/**
 * Polymarket Latency Benchmark (NL laptop friendly)
 *
 * Measures:
 * - REST place (post-only limit) HTTP RTT
 * - Time until user WS sees order LIVE
 * - REST cancel latency (batch cancel endpoint)
 *
 * Safety:
 * - Uses post-only limit far from touch to avoid accidental taker fills.
 * - Does NOT run taker benchmarks unless you explicitly enable it (LAT_BENCH_TAKER=1).
 *
 * Run:
 *   LAT_BENCH_ITERS=20 LAT_BENCH_USD_SIZE=1 npm run latency-bench
 */

import '@/lib/env/bootstrap';
import { btc15mMarketDiscovery } from '@/lib/market-discovery';
import { getPolymarketWS } from '@/lib/websocket/polymarket-ws';
import { orderPlacementService } from '@/lib/order-placement';

function envNum(key: string, def: number) {
  const v = process.env[key];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envBool(key: string, def: boolean) {
  const v = (process.env[key] || '').toLowerCase();
  if (!v) return def;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return def;
}

type Stat = { min: number; p50: number; p95: number; max: number; mean: number; n: number };

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function summarize(ms: number[]): Stat {
  const v = ms.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  const mean = n ? v.reduce((a, b) => a + b, 0) / n : 0;
  return {
    min: n ? v[0] : 0,
    p50: n ? percentile(v, 50) : 0,
    p95: n ? percentile(v, 95) : 0,
    max: n ? v[n - 1] : 0,
    mean,
    n,
  };
}

function msSince(t0: bigint) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function waitFor<T>(
  getValue: () => T | null,
  timeoutMs: number,
  pollMs: number = 10
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = getValue();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function main() {
  const ITERS = Math.max(1, Math.floor(envNum('LAT_BENCH_ITERS', 20)));
  const SIZE = envNum('LAT_BENCH_USD_SIZE', 1);
  const TICK = envNum('LAT_BENCH_TICK', 0.01);
  const SAFE_TICKS_AWAY = Math.max(5, Math.floor(envNum('LAT_BENCH_SAFE_TICKS_AWAY', 25)));
  const TIMEOUT_MS = Math.max(500, Math.floor(envNum('LAT_BENCH_TIMEOUT_MS', 5000)));
  const RUN_TAKER = envBool('LAT_BENCH_TAKER', false);

  if (!orderPlacementService.hasCredentials()) {
    throw new Error('Missing Polymarket API credentials (POLYMARKET_API_KEY/SECRET/PASSPHRASE).');
  }

  const market = await btc15mMarketDiscovery.findActiveMarket();
  if (!market) throw new Error('No BTC 15m market found.');

  const assetId = market.upTokenId; // benchmark on UP token by default

  const ws = getPolymarketWS();
  await ws.connectMarket();
  await ws.connectUser();
  ws.subscribeToAsset(assetId, market.conditionId);

  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  ws.on('orderbook', (u: any) => {
    if (String(u.assetId) !== assetId) return;
    if (typeof u.bestBid === 'number') bestBid = u.bestBid;
    if (typeof u.bestAsk === 'number') bestAsk = u.bestAsk;
  });

  // Wait for first book
  await waitFor(() => (bestBid != null && bestAsk != null ? true : null), 5000, 25);
  if (bestBid == null || bestAsk == null) throw new Error('Did not receive orderbook for asset.');

  // Track user WS order updates by orderId
  const orderLiveAtMs = new Map<string, number>(); // orderId -> t(ms epoch)
  const orderMatchedAtMs = new Map<string, number>();
  const ourOrderIds = new Set<string>();
  ws.on('order', (o: any) => {
    const id = String(o.orderId || '');
    if (!id) return;
    // Only track orders we created in this benchmark
    if (!ourOrderIds.has(id)) return;
    const ts = o.timestamp ? new Date(o.timestamp).getTime() : Date.now();
    if (o.status === 'LIVE') orderLiveAtMs.set(id, ts);
    if (o.status === 'MATCHED') orderMatchedAtMs.set(id, ts);
  });
  // Use the raw-ish trade event (includes takerOrderId/makerOrderId) and filter to our orders.
  ws.on('trade', (t: any) => {
    const oid = String(t.takerOrderId || t.makerOrderId || '');
    if (!oid) return;
    if (!ourOrderIds.has(oid)) return;
    orderMatchedAtMs.set(oid, t.timestamp ? new Date(t.timestamp).getTime() : Date.now());
  });

  const placeHttp: number[] = [];
  const placeToLive: number[] = [];
  const cancelHttp: number[] = [];

  console.log('=== Polymarket Latency Bench ===');
  console.log(`Market: ${market.slug}`);
  console.log(`Condition: ${market.conditionId}`);
  console.log(`Asset (UP): ${assetId}`);
  console.log(`iters=${ITERS} size=${SIZE} tick=${TICK} safeTicksAway=${SAFE_TICKS_AWAY} timeout=${TIMEOUT_MS}ms taker=${RUN_TAKER}`);

  for (let i = 0; i < ITERS; i++) {
    // Refresh safe price off current book
    const bid = bestBid ?? 0.5;
    const safeBuy = Math.max(0.01, Math.min(0.99, bid - SAFE_TICKS_AWAY * TICK));

    // Place post-only BUY far below touch
    const t0 = process.hrtime.bigint();
    let resp: any;
    try {
      resp = await orderPlacementService.placeLimitOrder({
        assetId,
        side: 'BUY',
        size: SIZE,
        price: safeBuy,
        postOnly: true,
        // Polymarket enforces a 1-minute security threshold on expiration; keep buffer to avoid clock skew.
        expiration: Math.floor(Date.now() / 1000) + 120, // short-lived (effective ~60s after threshold)
      });
    } catch (e) {
      console.error('\n❌ placeLimitOrder failed:', e);
      throw e;
    }
    const placeMs = msSince(t0);
    placeHttp.push(placeMs);

    const orderId = String(resp?.orderId || '');
    if (!orderId || orderId === 'undefined') {
      throw new Error('placeLimitOrder returned empty orderId; order was likely rejected.');
    }
    ourOrderIds.add(orderId);
    const placedAtEpoch = Date.now();

    // Wait for LIVE via user WS
    const liveTs = await waitFor(() => orderLiveAtMs.get(orderId) ?? null, TIMEOUT_MS, 10);
    if (liveTs != null) {
      placeToLive.push(liveTs - placedAtEpoch);
    }

    // Cancel via batch endpoint (single-id list)
    const t1 = process.hrtime.bigint();
    await orderPlacementService.cancelOrdersL2([orderId]);
    cancelHttp.push(msSince(t1));

    // Small spacing to avoid rate-limit clustering
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.write(`.\u001b[0m`);
  }
  process.stdout.write('\n');

  console.log('--- Results (ms) ---');
  console.log('place HTTP:', summarize(placeHttp));
  console.log('place → LIVE (user WS):', summarize(placeToLive));
  console.log('cancel HTTP (batch):', summarize(cancelHttp));

  if (RUN_TAKER) {
    console.log('\nTaker benchmark not implemented in this script by default (safety).');
    console.log('If you truly want it, we’ll add a separate explicit script requiring a confirmation flag.');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

