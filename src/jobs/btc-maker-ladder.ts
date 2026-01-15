/**
 * BTC 15m Maker Ladder Bot (post-only limit orders)
 *
 * Goal:
 * - Maintain a small set of resting (maker) limit orders around the current book
 * - Use "cached" order templates (pre-built payload params) and send in controlled bursts
 * - Safety: cancel quotes during fast Binance spikes (adverse selection guard)
 *
 * IMPORTANT:
 * - If your LIMIT crosses the spread, it's effectively a taker (and you will not avoid taker latency).
 * - Default is DRY RUN. Set MAKER_DRY_RUN=0 to actually place/cancel orders.
 */

import WebSocket from 'ws';
import { btc15mMarketDiscovery } from '@/lib/market-discovery';
import { getPolymarketWS } from '@/lib/websocket/polymarket-ws';
import { orderPlacementService } from '@/lib/order-placement';

type Side = 'BUY' | 'SELL';

type Book = {
  bestBid?: number;
  bestAsk?: number;
  ts: number;
};

function envNum(key: string, def: number) {
  const v = process.env[key];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envBool(key: string, def: boolean) {
  const v = (process.env[key] || '').toLowerCase();
  if (!v) return def;
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return def;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function roundToTick(price: number, tick: number) {
  if (!Number.isFinite(price)) return price;
  const t = Math.max(1e-6, tick);
  return Math.round(price / t) * t;
}

function keyFor(assetId: string, side: Side, price: number) {
  // normalize to 4dp for stable keys (binary market ticks are usually 0.01)
  return `${assetId}:${side}:${price.toFixed(4)}`;
}

class MakerOrderCache {
  // Cache desired orders by key, mapped to last known orderId if live
  liveOrderIdByKey = new Map<string, string>();

  remember(key: string, orderId: string) {
    if (orderId) this.liveOrderIdByKey.set(key, orderId);
  }
  forgetByOrderId(orderId: string) {
    for (const [k, v] of this.liveOrderIdByKey.entries()) {
      if (v === orderId) this.liveOrderIdByKey.delete(k);
    }
  }
  allLiveOrderIds() {
    return Array.from(new Set(this.liveOrderIdByKey.values()));
  }
}

async function main() {
  const DRY_RUN = envBool('MAKER_DRY_RUN', true);
  const CANCEL_ON_START = envBool('MAKER_CANCEL_ON_START', true);
  const CANCEL_ALL_ON_START = envBool('MAKER_CANCEL_ALL_ON_START', false);
  const EVENT_DRIVEN = envBool('MAKER_EVENT_DRIVEN', true);
  const EVENT_DEBOUNCE_MS = clamp(envNum('MAKER_EVENT_DEBOUNCE_MS', 15), 0, 250);

  const LEVELS = Math.max(1, Math.floor(envNum('MAKER_LEVELS', 3)));
  const TICK = clamp(envNum('MAKER_TICK', 0.01), 0.0001, 0.05);
  const SIZE = envNum('MAKER_SIZE', 5); // NOTE: this is the CLOB "size" field; verify units.
  // Used as safety fallback in event-driven mode; in polling mode it's the main loop interval.
  const REFRESH_MS = clamp(envNum('MAKER_REFRESH_MS', 750), 50, 10_000);
  const BURST_PLACE = Math.max(1, Math.floor(envNum('MAKER_BURST_PLACE', 5)));
  const BURST_CANCEL = Math.max(1, Math.floor(envNum('MAKER_BURST_CANCEL', 10)));

  const SPIKE_USD = envNum('MAKER_SPIKE_USD', 6);
  const SPIKE_WINDOW_MS = clamp(envNum('MAKER_SPIKE_WINDOW_MS', 250), 50, 2000);
  const SPIKE_COOLDOWN_MS = clamp(envNum('MAKER_SPIKE_COOLDOWN_MS', 1200), 0, 30_000);

  const QUOTE_BOTH_ASSETS = envBool('MAKER_QUOTE_BOTH_ASSETS', true);
  const QUOTE_BOTH_SIDES = envBool('MAKER_QUOTE_BOTH_SIDES', true);

  if (!orderPlacementService.hasCredentials()) {
    console.log('❌ Missing Polymarket API credentials (POLYMARKET_API_KEY/SECRET/PASSPHRASE).');
    process.exit(1);
  }

  console.log('=== BTC Maker Ladder Bot ===');
  console.log(`DRY_RUN=${DRY_RUN} (set MAKER_DRY_RUN=0 to trade)`);
  console.log(`levels=${LEVELS} tick=${TICK} size=${SIZE} refresh=${REFRESH_MS}ms eventDriven=${EVENT_DRIVEN} debounce=${EVENT_DEBOUNCE_MS}ms`);
  console.log(`spikeGuard: ${SPIKE_USD}$ over ${SPIKE_WINDOW_MS}ms -> cooldown ${SPIKE_COOLDOWN_MS}ms`);

  const ws = getPolymarketWS();
  await ws.connectMarket();
  await ws.connectUser();

  const cache = new MakerOrderCache();

  // Track current market + assets
  let upAssetId: string | null = null;
  let downAssetId: string | null = null;
  let currentConditionId: string | null = null;

  const books = new Map<string, Book>();
  const getBook = (assetId: string) => books.get(assetId);

  ws.on('orderbook', (u: any) => {
    const assetId = String(u.assetId);
    const bestBid = typeof u.bestBid === 'number' ? u.bestBid : undefined;
    const bestAsk = typeof u.bestAsk === 'number' ? u.bestAsk : undefined;
    books.set(assetId, { bestBid, bestAsk, ts: Date.now() });
    scheduleLoop('orderbook');
  });

  // Keep local live orders map via user channel
  ws.on('order', (o: any) => {
    const orderId = String(o.orderId || '');
    const status = String(o.status || '');
    if (!orderId) return;
    if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'MATCHED') {
      cache.forgetByOrderId(orderId);
    }
    scheduleLoop('order');
  });

  // Binance WS for spike guard (fast move detection)
  let lastBinance: { p: number; t: number } | null = null;
  let spikeUntil = 0;

  const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@bookTicker');
  binanceWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const bid = Number(msg.b);
      const t = Date.now();
      if (!Number.isFinite(bid)) return;

      if (lastBinance && t - lastBinance.t <= SPIKE_WINDOW_MS) {
        const d = bid - lastBinance.p;
        if (Math.abs(d) >= SPIKE_USD) {
          spikeUntil = Math.max(spikeUntil, t + SPIKE_COOLDOWN_MS);
          scheduleLoop('spike');
        }
      }
      lastBinance = { p: bid, t };
    } catch {}
  });
  binanceWs.on('open', () => console.log('✅ Binance WS connected (spike guard)'));
  binanceWs.on('error', (e) => console.error('Binance WS error:', e));

  async function refreshMarket() {
    const market = await btc15mMarketDiscovery.findActiveMarket();
    if (!market) throw new Error('No BTC 15m market found');

    const changed = market.conditionId !== currentConditionId;
    currentConditionId = market.conditionId;
    upAssetId = market.upTokenId;
    downAssetId = market.downTokenId;

    if (changed) {
      console.log('🔄 Market updated:', market.slug);
      console.log('  conditionId:', market.conditionId);
      console.log('  up:', upAssetId?.slice(0, 16) + '...');
      console.log('  down:', downAssetId?.slice(0, 16) + '...');
    }

    // Subscribe to books
    if (upAssetId) ws.subscribeToAsset(upAssetId, market.conditionId);
    if (downAssetId) ws.subscribeToAsset(downAssetId, market.conditionId);
  }

  await refreshMarket();
  setInterval(() => refreshMarket().catch((e) => console.error('refreshMarket error:', e)), 60_000);

  if (CANCEL_ON_START) {
    if (CANCEL_ALL_ON_START) {
      console.log('🧹 Cancel-on-start enabled (CANCEL ALL)...');
      if (!DRY_RUN) {
        const r = await orderPlacementService.cancelAll();
        console.log(`  canceled ${r.canceled?.length || 0} orders`);
      } else {
        console.log('  DRY cancel-all');
      }
    } else {
      console.log('🧹 Cancel-on-start enabled; fetching open orders...');
      const open = await orderPlacementService.getOpenOrders();
      const ids = open.map((o) => o.orderId);
      console.log(`  found ${ids.length} open orders`);
      if (!DRY_RUN && ids.length) {
        await orderPlacementService.cancelOrders(ids, 5);
      }
    }
  }

  function desiredOrdersForAsset(assetId: string, book: Book) {
    const desired: Array<{ assetId: string; side: Side; price: number; size: number; key: string }> = [];
    const bid = book.bestBid;
    const ask = book.bestAsk;
    if (typeof bid !== 'number' || typeof ask !== 'number') return desired;

    // Never cross. Post-only should enforce, but we also keep a safety margin.
    const safeBid = Math.min(bid, ask - TICK);
    const safeAsk = Math.max(ask, bid + TICK);

    for (let i = 0; i < LEVELS; i++) {
      const pxBid = clamp(roundToTick(safeBid - i * TICK, TICK), 0.01, 0.99);
      const pxAsk = clamp(roundToTick(safeAsk + i * TICK, TICK), 0.01, 0.99);

      if (QUOTE_BOTH_SIDES) {
        desired.push({ assetId, side: 'BUY', price: pxBid, size: SIZE, key: keyFor(assetId, 'BUY', pxBid) });
        desired.push({ assetId, side: 'SELL', price: pxAsk, size: SIZE, key: keyFor(assetId, 'SELL', pxAsk) });
      } else {
        // If not both sides, default to quoting BUY only (safer)
        desired.push({ assetId, side: 'BUY', price: pxBid, size: SIZE, key: keyFor(assetId, 'BUY', pxBid) });
      }
    }

    return desired;
  }

  async function cancelSome(orderIds: string[]) {
    const ids = orderIds.slice(0, BURST_CANCEL);
    if (ids.length === 0) return;
    if (DRY_RUN) {
      console.log(`DRY cancel burst: ${ids.length}`);
      return;
    }
    await orderPlacementService.cancelOrders(ids, 5);
  }

  async function placeSome(orders: Array<{ assetId: string; side: Side; price: number; size: number; key: string }>) {
    const slice = orders.slice(0, BURST_PLACE);
    for (const o of slice) {
      if (DRY_RUN) {
        console.log(`DRY place: ${o.side} ${o.size} @ ${o.price.toFixed(4)} (${o.assetId.slice(0, 10)}...)`);
        continue;
      }
      try {
        const r = await orderPlacementService.placeLimitOrder({
          assetId: o.assetId,
          side: o.side,
          size: o.size,
          price: o.price,
          postOnly: true,
        });
        cache.remember(o.key, r.orderId);
      } catch (e) {
        // Common for post-only: would-cross / rejected. Log compactly.
        console.error(`place failed (${o.side} ${o.price.toFixed(4)}):`, e instanceof Error ? e.message : e);
      }
    }
  }

  async function loopOnce() {
    const now = Date.now();

    // Spike guard: cancel everything and wait
    if (now < spikeUntil) {
      // Fast path: cancel by market/asset in a single request per asset (lower latency than cancelling many IDs).
      if (!DRY_RUN) {
        const market = currentConditionId || undefined;
        if (upAssetId) await orderPlacementService.cancelMarketOrders({ market, assetId: upAssetId });
        if (QUOTE_BOTH_ASSETS && downAssetId) await orderPlacementService.cancelMarketOrders({ market, assetId: downAssetId });
      } else {
        console.log(`⚠️ Spike guard active (${spikeUntil - now}ms left). DRY cancel-market-orders`);
      }
      return;
    }

    const assets: string[] = [];
    if (upAssetId) assets.push(upAssetId);
    if (QUOTE_BOTH_ASSETS && downAssetId) assets.push(downAssetId);

    const desiredAll: Array<{ assetId: string; side: Side; price: number; size: number; key: string }> = [];
    for (const assetId of assets) {
      const book = getBook(assetId);
      if (!book) continue;
      desiredAll.push(...desiredOrdersForAsset(assetId, book));
    }

    if (desiredAll.length === 0) return;

    const desiredKeys = new Set(desiredAll.map((d) => d.key));
    const liveKeys = Array.from(cache.liveOrderIdByKey.keys());

    // Extra live orders not desired anymore -> cancel
    const toCancel: string[] = [];
    for (const k of liveKeys) {
      if (!desiredKeys.has(k)) {
        const id = cache.liveOrderIdByKey.get(k);
        if (id) toCancel.push(id);
        cache.liveOrderIdByKey.delete(k);
      }
    }

    // Missing desired orders -> place
    const toPlace = desiredAll.filter((d) => !cache.liveOrderIdByKey.has(d.key));

    if (toCancel.length) await cancelSome(toCancel);
    if (toPlace.length) await placeSome(toPlace);
  }

  console.log('✅ Maker ladder running. Ctrl+C to stop.');

  // Event-driven scheduler: run ASAP after relevant updates, debounced.
  let pending = false;
  let scheduled: NodeJS.Timeout | null = null;
  let lastRun = 0;

  function scheduleLoop(reason: string) {
    if (!EVENT_DRIVEN) return;
    if (pending) return;
    pending = true;
    if (scheduled) clearTimeout(scheduled);

    const now = Date.now();
    const since = now - lastRun;
    const delay = Math.max(EVENT_DEBOUNCE_MS, since < 10 ? 10 : 0); // avoid tight loops on bursty feeds

    scheduled = setTimeout(() => {
      pending = false;
      lastRun = Date.now();
      loopOnce().catch((e) => console.error(`loop error (${reason}):`, e));
    }, delay);
  }

  // Safety timer (still useful for recovery / missed events)
  const timer = setInterval(() => {
    if (!EVENT_DRIVEN) {
      loopOnce().catch((e) => console.error('loop error:', e));
      return;
    }
    // In event-driven mode, only run if we haven't run in a while.
    if (Date.now() - lastRun > REFRESH_MS) {
      scheduleLoop('safety');
    }
  }, Math.max(50, Math.min(REFRESH_MS, 1000)));

  function shutdown() {
    console.log('Shutting down...');
    clearInterval(timer);
    if (scheduled) clearTimeout(scheduled);
    try {
      binanceWs.close();
    } catch {}
    try {
      ws.disconnect();
    } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

