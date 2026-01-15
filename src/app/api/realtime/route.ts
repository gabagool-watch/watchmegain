/**
 * Real-time Updates API (Server-Sent Events)
 * 
 * Streams real-time updates to the frontend using SSE.
 */

import { NextRequest, NextResponse } from 'next/server';
import { 
  getPolymarketWS, 
  type RealtimePriceUpdate, 
  type RealtimeTradeUpdate,
  type RealtimeOrderUpdate,
} from '@/lib/websocket/polymarket-ws';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GAMMA_MARKETS_API = process.env.GAMMA_MARKETS_API || 'https://gamma-api.polymarket.com';
const gammaConditionCache = new Map<string, any>();

async function fetchActiveBtc15mTokens(): Promise<{ conditionId: string; upTokenId: string; downTokenId: string } | null> {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSize = 15 * 60;
    const base = Math.floor(nowSec / windowSize) * windowSize;

    const parse = (market: any) => {
      const conditionId = market.condition_id || market.conditionId;
      if (!conditionId) return null;

      let outcomes: string[];
      let tokenIds: string[];
      try {
        outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
        tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
      } catch {
        return null;
      }
      if (!Array.isArray(outcomes) || !Array.isArray(tokenIds) || outcomes.length < 2 || tokenIds.length < 2) return null;

      let upTokenId: string | null = null;
      let downTokenId: string | null = null;
      outcomes.forEach((o: string, i: number) => {
        const v = String(o || '').toLowerCase();
        if (v === 'up' || v === 'yes') upTokenId = tokenIds[i];
        if (v === 'down' || v === 'no') downTokenId = tokenIds[i];
      });
      if (!upTokenId || !downTokenId) return null;
      return { conditionId, upTokenId, downTokenId };
    };

    // Try current + nearby windows; pick the first that parses.
    for (let i = -1; i <= 3; i++) {
      const start = base + i * windowSize;
      const slug = `btc-updown-15m-${start}`;
      const res = await fetch(`${GAMMA_MARKETS_API}/markets?slug=${slug}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const data = await res.json();
      const m = Array.isArray(data) ? data[0] : data;
      const parsed = m ? parse(m) : null;
      if (parsed) return parsed;
    }
    return null;
  } catch (e) {
    console.error('fetchActiveBtc15mTokens failed:', e);
    return null;
  }
}

async function fetchGammaMarketByConditionId(conditionId: string) {
  if (gammaConditionCache.has(conditionId)) return gammaConditionCache.get(conditionId);
  const url = `${GAMMA_MARKETS_API}/markets?condition_id=${encodeURIComponent(conditionId)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  const arr = (await res.json()) as any[];
  const m = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  gammaConditionCache.set(conditionId, m);
  return m;
}

// Store active connections for cleanup
const activeConnections = new Set<() => void>();

export async function GET(request: NextRequest) {
  // Get wallet address from query params
  const walletAddress = request.nextUrl.searchParams.get('wallet');
  
  console.log('🔌 New SSE connection request');
  
  // Create a TransformStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  let isClosed = false;
  
  // Helper to send SSE events
  const sendEvent = async (event: string, data: unknown) => {
    if (isClosed) return;
    try {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      await writer.write(encoder.encode(message));
    } catch (error) {
      console.error('Error sending SSE event:', error);
      isClosed = true;
    }
  };
  
  // Cleanup function
  const cleanup = () => {
    isClosed = true;
    activeConnections.delete(cleanup);
  };
  
  activeConnections.add(cleanup);
  
  // Start the connection in a separate async context
  (async () => {
    try {
      const ws = getPolymarketWS();
      
      // Send initial connection message
      await sendEvent('status', { 
        connected: false, 
        userConnected: false,
        message: 'Initializing...',
        hasAuth: ws.hasCredentials(),
      });
      
      // Heartbeat interval
      const heartbeatInterval = setInterval(async () => {
        if (isClosed) {
          clearInterval(heartbeatInterval);
          return;
        }
        await sendEvent('heartbeat', { timestamp: new Date().toISOString() });
      }, 15000);
      
      // Event handlers
      const onPrice = async (update: RealtimePriceUpdate) => {
        await sendEvent('price', {
          assetId: update.assetId,
          conditionId: update.conditionId,
          price: update.price,
          bestBid: update.bestBid,
          bestAsk: update.bestAsk,
          timestamp: update.timestamp.toISOString(),
        });
      };
      
      const onTrade = async (update: RealtimeTradeUpdate) => {
        if (walletAddress && !update.isOwn) {
          const addr = walletAddress.toLowerCase();
          if (update.makerAddress?.toLowerCase() !== addr && 
              update.takerAddress?.toLowerCase() !== addr) {
            return;
          }
        }
        
        await sendEvent('trade', {
          assetId: update.assetId,
          conditionId: update.conditionId,
          side: update.side,
          size: update.size,
          price: update.price,
          timestamp: update.timestamp.toISOString(),
          isOwn: update.isOwn,
        });
      };
      
      const onOrder = async (update: RealtimeOrderUpdate) => {
        console.log('📤 Sending order update:', update.status);
        await sendEvent('order', {
          orderId: update.orderId,
          assetId: update.assetId,
          conditionId: update.conditionId,
          side: update.side,
          status: update.status,
          originalSize: update.originalSize,
          sizeMatched: update.sizeMatched,
          price: update.price,
          timestamp: update.timestamp.toISOString(),
          market: update.market,
          outcome: update.outcome,
        });
      };
      
      const onUserTrade = async (update: RealtimeTradeUpdate) => {
        console.log('📤 Sending user trade:', update.side, update.size);
        await sendEvent('user_trade', {
          assetId: update.assetId,
          conditionId: update.conditionId,
          side: update.side,
          size: update.size,
          price: update.price,
          timestamp: update.timestamp.toISOString(),
          isOwn: true,
        });
      };
      
      const onConnected = async () => {
        await sendEvent('status', { 
          connected: true, 
          userConnected: ws.isUserConnected(),
          message: 'Connected to Polymarket',
        });
      };
      
      const onDisconnected = async () => {
        await sendEvent('status', { 
          connected: false, 
          userConnected: false,
          message: 'Disconnected',
        });
      };
      
      const onUserConnected = async () => {
        await sendEvent('status', { 
          connected: ws.isConnected(),
          userConnected: true,
          message: '🔐 User WebSocket connected',
        });
      };
      
      const onError = async (error: Error) => {
        await sendEvent('error', { message: error.message || 'WebSocket error' });
      };
      
      // Subscribe to events
      ws.on('price', onPrice);
      ws.on('trade', onTrade);
      ws.on('orderbook', onPrice);
      ws.on('order', onOrder);
      ws.on('user_trade', onUserTrade);
      ws.on('connected', onConnected);
      ws.on('disconnected', onDisconnected);
      ws.on('user_connected', onUserConnected);
      ws.on('user_disconnected', onDisconnected);
      ws.on('error', onError);
      ws.on('user_error', onError);
      
      // Connect WebSocket if not connected
      if (!ws.isConnected()) {
        console.log('🔌 Starting WebSocket connection...');
        try {
          await ws.connect();
          console.log('✅ WebSocket connected');
          
          // Subscribe to tracked markets (we need Polymarket *asset/token ids*, not condition ids)
          const positions = await prisma.position.findMany({
            where: { 
              status: 'OPEN',
              ...(walletAddress ? { wallet: { address: walletAddress.toLowerCase() } } : {}),
            },
            include: { market: true },
          });
          
          const subscribedAssetIds = new Set<string>();
          const subscribedConditionIds = new Set<string>();

          for (const p of positions) {
            const conditionId = p.market?.conditionId;
            if (typeof conditionId === 'string') subscribedConditionIds.add(conditionId);

            const outcomes = (p.market?.outcomes as any) as any[];
            const tokenId = Array.isArray(outcomes) ? outcomes?.[p.outcome]?.tokenId : null;
            if (typeof tokenId === 'string' && tokenId.length > 0 && !subscribedAssetIds.has(tokenId)) {
              // Also store mapping so trade/order updates can include conditionId
              ws.subscribeToAsset(tokenId, conditionId);
              subscribedAssetIds.add(tokenId);
            }
          }

          // Fallback: if tokenId is missing in DB outcomes, resolve via Gamma and (optionally) backfill DB.
          if (subscribedAssetIds.size === 0 && subscribedConditionIds.size > 0) {
            for (const p of positions) {
              const conditionId = p.market?.conditionId;
              if (!conditionId) continue;

              const outcomes = (p.market?.outcomes as any) as any[];
              const existingTokenId = Array.isArray(outcomes) ? outcomes?.[p.outcome]?.tokenId : null;
              if (typeof existingTokenId === 'string' && existingTokenId.length > 0) continue;

              const gamma = await fetchGammaMarketByConditionId(conditionId);
              const tokens = gamma?.tokens;
              const resolvedTokenId = Array.isArray(tokens) ? tokens?.[p.outcome]?.token_id : null;
              if (typeof resolvedTokenId === 'string' && resolvedTokenId.length > 0 && !subscribedAssetIds.has(resolvedTokenId)) {
                ws.subscribeToAsset(resolvedTokenId, conditionId);
                subscribedAssetIds.add(resolvedTokenId);

                // Best-effort DB backfill so future connects don’t need Gamma.
                try {
                  const mergedOutcomes = Array.isArray(outcomes)
                    ? outcomes.map((o, idx) => (idx === p.outcome ? { ...(o as any), tokenId: resolvedTokenId } : o))
                    : outcomes;
                  await prisma.market.update({
                    where: { conditionId },
                    data: { outcomes: mergedOutcomes as any },
                  });
                } catch {
                  // ignore
                }
              }
            }
          }

          // Final fallback: even if the DB markets are mock/seed (non-resolvable),
          // subscribe to the active BTC 15m market so the realtime stream is always alive.
          if (subscribedAssetIds.size === 0) {
            const btc = await fetchActiveBtc15mTokens();
            if (btc?.upTokenId && btc?.downTokenId) {
              ws.subscribeToAsset(btc.upTokenId, btc.conditionId);
              ws.subscribeToAsset(btc.downTokenId, btc.conditionId);
              subscribedAssetIds.add(btc.upTokenId);
              subscribedAssetIds.add(btc.downTokenId);
              subscribedConditionIds.add(btc.conditionId);
            } else {
              console.warn('⚠️ No BTC15m tokenIds found for realtime fallback subscription');
            }
          }
          
          await sendEvent('status', { 
            connected: true, 
            userConnected: ws.isUserConnected(),
            message: `Subscribed to ${subscribedAssetIds.size} assets (${subscribedConditionIds.size} markets)`,
            markets: subscribedConditionIds.size,
            hasAuth: ws.hasCredentials(),
          });
        } catch (error) {
          console.error('Failed to connect WebSocket:', error);
          await sendEvent('error', { message: error instanceof Error ? error.message : String(error) });
        }
      } else {
        console.log('✅ WebSocket already connected');
        await sendEvent('status', { 
          connected: true, 
          userConnected: ws.isUserConnected(),
          message: 'Already connected',
          hasAuth: ws.hasCredentials(),
        });
      }
      
      // Wait for client disconnect
      request.signal.addEventListener('abort', () => {
        console.log('🔌 SSE client disconnected');
        clearInterval(heartbeatInterval);
        
        // Remove event listeners
        ws.off('price', onPrice);
        ws.off('trade', onTrade);
        ws.off('orderbook', onPrice);
        ws.off('order', onOrder);
        ws.off('user_trade', onUserTrade);
        ws.off('connected', onConnected);
        ws.off('disconnected', onDisconnected);
        ws.off('user_connected', onUserConnected);
        ws.off('user_disconnected', onDisconnected);
        ws.off('error', onError);
        ws.off('user_error', onError);
        
        cleanup();
        writer.close().catch(() => {});
      });
      
    } catch (error) {
      console.error('SSE error:', error);
      cleanup();
      writer.close().catch(() => {});
    }
  })();
  
  // Return the response immediately with the readable stream
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}

// Simple status endpoint for debugging
export async function POST() {
  const ws = getPolymarketWS();
  
  return NextResponse.json({
    marketConnected: ws.isConnected(),
    userConnected: ws.isUserConnected(),
    hasCredentials: ws.hasCredentials(),
    subscribedMarkets: ws.getSubscribedCount(),
    activeConnections: activeConnections.size,
  });
}
