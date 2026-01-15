/**
 * BTC Lag Recorder
 *
 * Doel:
 * - Real-time prijzen loggen van:
 *   - Binance (BTCUSDT best bid/ask via WebSocket)
 *   - Polymarket (BTC 15m market asset via WebSocket)
 * - Alle samples in de database schrijven (tabel: price_samples)
 *
 * Hiermee kun je later heel precies analyseren:
 * - Hoeveel ms / ticks Polymarket achterloopt t.o.v. Binance
 * - Of die lag terug te zien is in de share price
 */

import WebSocket from 'ws';
import prisma from '@/lib/db';
import { getPolymarketWS } from '@/lib/websocket/polymarket-ws';
import { btc15mMarketDiscovery } from '@/lib/market-discovery';
import { getChainlinkBTCUSDWS } from '@/lib/websocket/chainlink-ws';
import { getPolymarketRTDS } from '@/lib/websocket/polymarket-rtds';

const BINANCE_WS_URL =
  process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';

// Throttle Binance sampling to avoid overwhelming Postgres (default: 100ms)
const BINANCE_SAMPLE_MS = Number(process.env.BINANCE_SAMPLE_MS || 100);

// Asset IDs worden automatisch elke 5 minuten opgehaald van de actieve BTC 15m market
let POLY_UP_ASSET_ID = '';
let POLY_DOWN_ASSET_ID = '';
let currentConditionId = '';
let currentMarketSlug = '';
let marketCheckInterval: NodeJS.Timeout | null = null;
let hasSubscribed = false;
let chainlinkStarted = false;
let rtdsStarted = false;
let currentMarketStartTime: Date | null = null;
let currentMarketEndTime: Date | null = null;

interface BinanceBookTicker {
  u: number; // order book updateId
  s: string; // symbol, e.g. BTCUSDT
  b: string; // best bid price
  B: string; // best bid qty
  a: string; // best ask price
  A: string; // best ask qty
  E?: number; // event time (ms)
}

type PriceSampleSide = 'BID' | 'ASK' | 'TRADE' | 'ORACLE' | 'BASELINE';

// ============ BATCH WRITE BUFFER ============
// Buffer samples and write in batches every FLUSH_INTERVAL_MS
const FLUSH_INTERVAL_MS = 1000; // Write every 1 second
const MAX_BUFFER_SIZE = 200; // Force flush if buffer exceeds this

interface PriceSampleData {
  source: string;
  symbol: string;
  price: number;
  side?: PriceSampleSide;
  isBestBid?: boolean;
  isBestAsk?: boolean;
  conditionId?: string;
  assetId?: string;
  marketSlug?: string;
  extraJson?: unknown;
  observedAt: Date;
}

let sampleBuffer: PriceSampleData[] = [];
let flushInterval: NodeJS.Timeout | null = null;
let isFlushingBuffer = false;

async function flushSampleBuffer() {
  if (isFlushingBuffer || sampleBuffer.length === 0) return;
  
  isFlushingBuffer = true;
  const toWrite = sampleBuffer;
  sampleBuffer = []; // Reset buffer immediately
  
  try {
    await prisma.priceSample.createMany({
      data: toWrite.map(s => ({
        source: s.source,
        symbol: s.symbol,
        price: s.price,
        side: s.side,
        isBestBid: s.isBestBid,
        isBestAsk: s.isBestAsk,
        conditionId: s.conditionId,
        assetId: s.assetId,
        marketSlug: s.marketSlug,
        observedAt: s.observedAt,
        extraJson: s.extraJson as any,
      })),
      skipDuplicates: true,
    });
    // Log every ~10 seconds (10 flushes)
    if (Math.random() < 0.1) {
      console.log(`📝 Flushed ${toWrite.length} samples to DB`);
    }
  } catch (error) {
    console.error(`❌ Failed to flush ${toWrite.length} samples:`, error);
    // Don't re-add to buffer on failure to avoid infinite growth
  } finally {
    isFlushingBuffer = false;
  }
}

function startBatchWriter() {
  if (flushInterval) return;
  flushInterval = setInterval(flushSampleBuffer, FLUSH_INTERVAL_MS);
  console.log(`📦 Batch writer started (flush every ${FLUSH_INTERVAL_MS}ms, max ${MAX_BUFFER_SIZE} samples)`);
}

function stopBatchWriter() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  // Final flush
  flushSampleBuffer();
}

function savePriceSample(params: {
  source: string;
  symbol: string;
  price: number;
  side?: PriceSampleSide;
  isBestBid?: boolean;
  isBestAsk?: boolean;
  conditionId?: string;
  assetId?: string;
  marketSlug?: string;
  extraJson?: unknown;
  observedAt?: Date;
}) {
  const sample: PriceSampleData = {
    source: params.source,
    symbol: params.symbol,
    price: params.price,
    side: params.side,
    isBestBid: params.isBestBid,
    isBestAsk: params.isBestAsk,
    conditionId: params.conditionId,
    assetId: params.assetId,
    marketSlug: params.marketSlug,
    extraJson: params.extraJson,
    observedAt: params.observedAt ?? new Date(),
  };
  
  sampleBuffer.push(sample);
  
  // Force flush if buffer is too large
  if (sampleBuffer.length >= MAX_BUFFER_SIZE) {
    flushSampleBuffer();
  }
}

// Async version for places that need to wait (like baseline)
async function savePriceSampleDirect(params: {
  source: string;
  symbol: string;
  price: number;
  side?: PriceSampleSide;
  isBestBid?: boolean;
  isBestAsk?: boolean;
  conditionId?: string;
  assetId?: string;
  marketSlug?: string;
  extraJson?: unknown;
  observedAt?: Date;
}) {
  try {
    await prisma.priceSample.create({
      data: {
        source: params.source,
        symbol: params.symbol,
        price: params.price,
        side: params.side,
        isBestBid: params.isBestBid,
        isBestAsk: params.isBestAsk,
        conditionId: params.conditionId,
        assetId: params.assetId,
        marketSlug: params.marketSlug,
        observedAt: params.observedAt ?? new Date(),
        extraJson: params.extraJson as any,
      },
    });
  } catch (error) {
    console.error('❌ Failed to save price sample (direct):', error);
  }
}

/**
 * Start Binance WebSocket en log BTCUSDT best bid/ask
 */
function startBinanceStream() {
  console.log(`🔌 Connecting to Binance WS: ${BINANCE_WS_URL}`);

  const ws = new WebSocket(BINANCE_WS_URL);
  let lastBidAt = 0;
  let lastAskAt = 0;
  let lastBidPrice: number | null = null;
  let lastAskPrice: number | null = null;

  ws.on('open', () => {
    console.log('✅ Binance WS connected');
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as BinanceBookTicker;
      const now = new Date();
      const nowMs = now.getTime();

      const bid = parseFloat(msg.b);
      const ask = parseFloat(msg.a);

      if (Number.isFinite(bid)) {
        const shouldWrite =
          lastBidPrice === null ||
          bid !== lastBidPrice ||
          nowMs - lastBidAt >= BINANCE_SAMPLE_MS;

        if (shouldWrite) {
          lastBidAt = nowMs;
          lastBidPrice = bid;
          savePriceSample({
            source: 'BINANCE',
            symbol: msg.s,
            price: bid,
            side: 'BID',
            isBestBid: true,
            observedAt: now,
            extraJson: { updateId: msg.u, qty: msg.B, eventTime: msg.E },
          });
        }
      }

      if (Number.isFinite(ask)) {
        const shouldWrite =
          lastAskPrice === null ||
          ask !== lastAskPrice ||
          nowMs - lastAskAt >= BINANCE_SAMPLE_MS;

        if (shouldWrite) {
          lastAskAt = nowMs;
          lastAskPrice = ask;
          savePriceSample({
            source: 'BINANCE',
            symbol: msg.s,
            price: ask,
            side: 'ASK',
            isBestAsk: true,
            observedAt: now,
            extraJson: { updateId: msg.u, qty: msg.A, eventTime: msg.E },
          });
        }
      }
    } catch (error) {
      console.error('Binance WS parse error:', error);
    }
  });

  ws.on('error', (err) => {
    console.error('Binance WS error:', err);
  });

  ws.on('close', (code, reason) => {
    console.error(`Binance WS closed: ${code} - ${reason.toString()}`);
    // Eenvoudige reconnect
    setTimeout(startBinanceStream, 5_000);
  });
}

/**
 * Update asset IDs van de actieve BTC 15m market
 * Wordt elke 5 minuten aangeroepen om automatisch te switchen naar nieuwe markets
 */
async function updateActiveMarketAssets() {
  try {
    const market = await btc15mMarketDiscovery.findActiveMarket();
    
    if (!market) {
      console.warn('⚠️ Geen actieve BTC 15m market gevonden, blijf huidige assets gebruiken');
      return;
    }

    // Check of we moeten switchen
    if (market.conditionId === currentConditionId) {
      // Zelfde market, geen actie nodig
      return;
    }

    console.log(`\n🔄 Nieuwe BTC 15m market gedetecteerd:`);
    console.log(`   Question: ${market.question}`);
    console.log(`   Condition ID: ${market.conditionId}`);
    console.log(`   UP Asset ID: ${market.upTokenId}`);
    console.log(`   DOWN Asset ID: ${market.downTokenId}\n`);

    // Update asset IDs
    const oldUpAsset = POLY_UP_ASSET_ID;
    const oldDownAsset = POLY_DOWN_ASSET_ID;

    POLY_UP_ASSET_ID = market.upTokenId;
    POLY_DOWN_ASSET_ID = market.downTokenId;
    currentConditionId = market.conditionId;
    currentMarketSlug = market.slug;
    currentMarketStartTime = market.startTime;
    currentMarketEndTime = market.endTime;

    // Update WS subscriptions (WS-only requirement)
    const ws = getPolymarketWS();
    if (ws.isConnected()) {
      if (hasSubscribed) {
        if (oldUpAsset) ws.unsubscribeFromAsset(oldUpAsset);
        if (oldDownAsset) ws.unsubscribeFromAsset(oldDownAsset);
      }

      ws.subscribeToAsset(POLY_UP_ASSET_ID, currentConditionId);
      ws.subscribeToAsset(POLY_DOWN_ASSET_ID, currentConditionId);
      hasSubscribed = true;

      console.log(`✅ WebSocket subscriptions updated naar nieuwe assets\n`);
    }

    // Record "price to beat" baseline for this 15m window (Chainlink price at market start tick).
    await ensurePriceToBeatBaseline({
      conditionId: currentConditionId,
      marketSlug: currentMarketSlug,
      startTime: market.startTime,
      endTime: market.endTime,
    });
  } catch (error) {
    console.error('❌ Failed to update active market assets:', error);
  }
}

async function ensurePriceToBeatBaseline(params: {
  conditionId: string;
  marketSlug: string;
  startTime: Date;
  endTime: Date;
}) {
  const { conditionId, marketSlug, startTime, endTime } = params;
  try {
    const existing = await prisma.priceSample.findFirst({
      where: {
        source: 'POLYMARKET_PRICE_TO_BEAT',
        symbol: 'BTCUSD',
        side: 'BASELINE',
        conditionId,
      },
      select: { id: true },
    });
    if (existing) return;

    // Find the Chainlink BTCUSD sample closest to the market start time.
    // Prefer Polymarket RTDS Chainlink (what Polymarket uses), fallback to on-chain Chainlink.
    const pickClosest = async (source: string) => {
      const before = await prisma.priceSample.findFirst({
        where: { source, symbol: 'BTCUSD', side: 'ORACLE', observedAt: { lt: startTime } },
        orderBy: { observedAt: 'desc' },
        select: { observedAt: true, price: true },
      });
      const after = await prisma.priceSample.findFirst({
        where: { source, symbol: 'BTCUSD', side: 'ORACLE', observedAt: { gte: startTime } },
        orderBy: { observedAt: 'asc' },
        select: { observedAt: true, price: true },
      });

      if (!before && !after) return null;
      if (!before) return { ...after!, source };
      if (!after) return { ...before!, source };
      const dBefore = Math.abs(before.observedAt.getTime() - startTime.getTime());
      const dAfter = Math.abs(after.observedAt.getTime() - startTime.getTime());
      return (dAfter <= dBefore ? after : before) ? { ...(dAfter <= dBefore ? after! : before!), source } : null;
    };

    const best =
      (await pickClosest('POLYMARKET_RTDS_CHAINLINK')) ?? (await pickClosest('CHAINLINK'));

    if (!best) {
      console.warn('⚠️ No Chainlink BTCUSD samples available yet to set price-to-beat baseline.');
      return;
    }

    await savePriceSampleDirect({
      source: 'POLYMARKET_PRICE_TO_BEAT',
      symbol: 'BTCUSD',
      side: 'BASELINE',
      price: best.price,
      conditionId,
      marketSlug,
      // Anchor baseline at the exact market start time (xx:00/15/30/45)
      observedAt: startTime,
      extraJson: {
        pickedSource: best.source,
        pickedObservedAt: best.observedAt,
        windowStart: startTime,
        windowEnd: endTime,
      },
    });

    console.log(
      `🎯 Price-to-beat baseline saved: ${best.price.toFixed(2)} (${best.source}) @ ${startTime.toISOString()}`
    );
  } catch (e) {
    console.error('❌ Failed to ensure price-to-beat baseline:', e);
  }
}

/**
 * Start Polymarket WebSocket en log BTC 15m asset prijzen
 */
async function startPolymarketStream() {
  const ws = getPolymarketWS();

  ws.on('trade', (update) => {
    if (!update.assetId) return;
    if (update.assetId !== POLY_UP_ASSET_ID && update.assetId !== POLY_DOWN_ASSET_ID) return;

    const symbol = update.assetId === POLY_UP_ASSET_ID ? 'POLY_BTC_15M_UP' : 'POLY_BTC_15M_DOWN';

    savePriceSample({
      source: 'POLYMARKET',
      symbol,
      price: update.price,
      side: 'TRADE',
      assetId: update.assetId,
      conditionId: update.conditionId,
      marketSlug: currentMarketSlug || undefined,
      observedAt: update.timestamp ?? new Date(),
      extraJson: { size: update.size, side: update.side },
    });
  });

  ws.on('orderbook', (update) => {
    if (!update.assetId) return;
    if (update.assetId !== POLY_UP_ASSET_ID && update.assetId !== POLY_DOWN_ASSET_ID) return;

    const symbol = update.assetId === POLY_UP_ASSET_ID ? 'POLY_BTC_15M_UP' : 'POLY_BTC_15M_DOWN';
    const now = update.timestamp ?? new Date();

    if (typeof update.bestBid === 'number') {
      savePriceSample({
        source: 'POLYMARKET',
        symbol,
        price: update.bestBid,
        side: 'BID',
        isBestBid: true,
        assetId: update.assetId,
        conditionId: update.conditionId,
        marketSlug: currentMarketSlug || undefined,
        observedAt: now,
      });
    }

    if (typeof update.bestAsk === 'number') {
      savePriceSample({
        source: 'POLYMARKET',
        symbol,
        price: update.bestAsk,
        side: 'ASK',
        isBestAsk: true,
        assetId: update.assetId,
        conditionId: update.conditionId,
        marketSlug: currentMarketSlug || undefined,
        observedAt: now,
      });
    }
  });

  ws.on('error', (err) => {
    console.error('Polymarket WS error:', err);
  });

  await ws.connect();

  // Initial market discovery + subscribe
  await updateActiveMarketAssets();

  // Check elke 5 minuten voor nieuwe markets
  marketCheckInterval = setInterval(updateActiveMarketAssets, 5 * 60 * 1000);

  console.log('✅ Polymarket WS connected, auto-updating assets elke 5 minuten');
}

/**
 * Start Chainlink BTC/USD WebSocket (Polygon logs) and record oracle updates
 */
async function startChainlinkStream() {
  if (chainlinkStarted) return;
  chainlinkStarted = true;

  let clWs: ReturnType<typeof getChainlinkBTCUSDWS> | null = null;
  try {
    clWs = getChainlinkBTCUSDWS();
  } catch (e) {
    console.warn(
      '⚠️ On-chain Chainlink WS not started (missing POLYGON_WSS_URL). ' +
        'Lag recorder will still log Polymarket RTDS Chainlink (if enabled), but you will not get Polygon-log Chainlink samples.'
    );
    return;
  }

  clWs.on('price', (u) => {
    if (!Number.isFinite(u.price)) return;
    savePriceSample({
      source: 'CHAINLINK',
      symbol: 'BTCUSD',
      price: u.price,
      side: 'ORACLE',
      observedAt: u.receivedAt,
      extraJson: {
        updatedAtSec: u.updatedAtSec,
        roundId: u.roundId,
        feed: u.feedAddress,
        blockNumber: u.blockNumber,
        txHash: u.txHash,
        logIndex: u.logIndex,
      },
    });
  });

  clWs.on('connected', () => console.log('🔌 Chainlink WS connected'));
  clWs.on('subscribed', (info: any) => console.log('📡 Chainlink WS subscribed', info?.subId ? `(id ${info.subId})` : ''));
  clWs.on('error', (err) => console.error('Chainlink WS error:', err));

  await clWs.connect();
}

/**
 * Start Polymarket RTDS crypto_prices (BTC reference) and record as "POLYMARKET_RTDS"
 */
async function startPolymarketRTDS() {
  if (rtdsStarted) return;
  rtdsStarted = true;

  const rtds = getPolymarketRTDS();
  rtds.on('crypto_price', (u: any) => {
    const topic = String(u.topic || '');
    const sym = String(u.symbol || '').toLowerCase();
    const value = Number(u.value);
    const obs = new Date(Number(u.messageTimestamp ?? Date.now()));

    if (!Number.isFinite(value)) return;

    // Chainlink feed within RTDS (this is what you asked for)
    if (topic === 'crypto_prices_chainlink' && sym === 'btc/usd') {
      savePriceSample({
        source: 'POLYMARKET_RTDS_CHAINLINK',
        symbol: 'BTCUSD',
        price: value,
        side: 'ORACLE',
        observedAt: obs,
        extraJson: { rtdsSymbol: u.symbol, payloadTimestamp: u.payloadTimestamp },
      });
    }
  });
  rtds.on('connected', () => console.log('🔌 Polymarket RTDS connected (crypto_prices)'));
  rtds.on('error', (e) => console.error('Polymarket RTDS error:', e));

  await rtds.connect();
}

async function cleanup() {
  console.log('\n🛑 Stopping lag recorder...');
  if (marketCheckInterval) {
    clearInterval(marketCheckInterval);
  }
  // Flush remaining samples before exit
  stopBatchWriter();
  await flushSampleBuffer();
  console.log('✅ Final flush complete');
  process.exit(0);
}

async function main() {
  console.log('=== BTC Lag Recorder ===');
  console.log('Dit script logt Binance + Polymarket prijzen in de DB (price_samples).');
  console.log('Asset IDs worden automatisch elke 5 minuten geüpdatet naar de actieve BTC 15m market.\n');

  // Start batch writer (buffers samples and writes every 1 second)
  startBatchWriter();

  // Start alle streams
  startBinanceStream();
  await startPolymarketStream();
  await startPolymarketRTDS();
  await startChainlinkStream();

  console.log('\n✅ Recorder running. Druk Ctrl+C om te stoppen.\n');

  // Graceful shutdown
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('Fatal error in lag-recorder:', err);
  process.exit(1);
});

