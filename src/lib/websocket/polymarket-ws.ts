/**
 * Polymarket WebSocket Client
 * 
 * Connects to Polymarket's WebSocket for real-time updates.
 * 
 * Public channels (no auth):
 * - wss://ws-subscriptions-clob.polymarket.com/ws/market - Price/orderbook updates
 * 
 * Authenticated channels (requires API key):
 * - wss://ws-subscriptions-clob.polymarket.com/ws/user - Your orders/trades
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import type WebSocket from 'ws';

// ws optionally uses native addons like `bufferutil`. On very new Node versions these can misbehave
// (e.g. "bufferUtil.mask is not a function"). Force ws to use the pure-JS implementation.
process.env.WS_NO_BUFFER_UTIL = process.env.WS_NO_BUFFER_UTIL || '1';
process.env.WS_NO_UTF_8_VALIDATE = process.env.WS_NO_UTF_8_VALIDATE || '1';

// IMPORTANT: do not `import WebSocket from 'ws'` because the env vars above must be set before ws is loaded.
const WebSocketCtor = require('ws') as unknown as {
  new (address: string | URL, options?: any): WebSocket;
  readonly OPEN: number;
};

const WS_MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_USER_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

// Message types from Polymarket WebSocket
interface WSMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Polymarket Market WS actual payloads (2026):
 * - Snapshot after subscribe: Array<{ market, asset_id, timestamp(ms), bids, asks, ... }>
 * - Updates: { market, price_changes: Array<{ asset_id, price, size, side, best_bid, best_ask, hash, ... }>, ... }
 */
interface MarketBookSnapshotItem {
  market: string;
  asset_id: string;
  timestamp: string; // ms since epoch
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash?: string;
}

interface MarketPriceChange {
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  best_bid?: string;
  best_ask?: string;
  hash?: string;
}

interface MarketPriceChangesMessage {
  market: string;
  price_changes: MarketPriceChange[];
  timestamp?: string; // sometimes present, ms since epoch
}

// User WebSocket message types
interface UserOrderUpdate {
  id: string;
  status: 'LIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED';
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  timestamp: string;
  market?: string;
  outcome?: string;
}

interface UserTradeUpdate {
  id: string;
  taker_order_id: string;
  maker_order_id: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  timestamp: string;
  status: string;
  fee_rate_bps?: string;
  market?: string;
  outcome?: string;
}

export interface RealtimePriceUpdate {
  assetId: string;
  conditionId?: string;
  price: number;
  bestBid?: number;
  bestAsk?: number;
  timestamp: Date;
}

export interface RealtimeTradeUpdate {
  assetId: string;
  conditionId?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  timestamp: Date;
  makerAddress?: string;
  takerAddress?: string;
  isOwn?: boolean; // True if this is the user's own trade
}

export interface RealtimeOrderUpdate {
  orderId: string;
  assetId: string;
  conditionId?: string;
  side: 'BUY' | 'SELL';
  status: 'LIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED';
  originalSize: number;
  sizeMatched: number;
  price: number;
  timestamp: Date;
  market?: string;
  outcome?: string;
}

export class PolymarketWebSocket extends EventEmitter {
  private marketWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private subscribedAssets: Set<string> = new Set();
  private isConnecting = false;
  private isUserConnecting = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private userPingInterval: NodeJS.Timeout | null = null;
  
  // API credentials for authenticated WebSocket
  private apiKey: string;
  private apiSecret: string;
  private passphrase: string;
  private walletAddress: string;
  
  // Asset ID to Condition ID mapping cache
  private assetToCondition: Map<string, string> = new Map();

  constructor() {
    super();
    this.setMaxListeners(100);
    
    // Load credentials from environment
    // Support both POLYMARKET_PASSPHRASE and POLYMARKET_API_PASSPHRASE for backwards compatibility
    this.apiKey = process.env.POLYMARKET_API_KEY || '';
    this.apiSecret = process.env.POLYMARKET_API_SECRET || '';
    this.passphrase = process.env.POLYMARKET_API_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE || '';
    this.walletAddress = process.env.POLYMARKET_ADDRESS || '';
  }

  /**
   * Check if we have valid credentials for authenticated WebSocket
   */
  hasCredentials(): boolean {
    const has = !!(this.apiKey && this.apiSecret && this.passphrase);
    if (!has) {
      console.log('⚠️ Missing credentials:', {
        hasApiKey: !!this.apiKey,
        hasApiSecret: !!this.apiSecret,
        hasPassphrase: !!this.passphrase,
      });
    }
    return has;
  }

  /**
   * Generate HMAC signature for WebSocket authentication
   */
  private generateSignature(timestamp: number, method: string, path: string, body: string = ''): string {
    const normalizeBase64 = (input: string) =>
      input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    const toUrlSafeBase64 = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

    const message = `${timestamp}${method}${path}${body}`;
    const key = Buffer.from(normalizeBase64(this.apiSecret), 'base64');
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(message);
    return toUrlSafeBase64(hmac.digest('base64'));
  }

  /**
   * Connect to the public market WebSocket
   */
  async connectMarket(): Promise<void> {
    if (this.marketWs?.readyState === WebSocketCtor.OPEN || this.isConnecting) {
      console.log('Market WebSocket already connected or connecting');
      return;
    }

    this.isConnecting = true;
    
    return new Promise((resolve, reject) => {
      try {
        console.log('🔌 Connecting to Polymarket Market WebSocket...');
        this.marketWs = new WebSocketCtor(WS_MARKET_URL);

        this.marketWs.on('open', () => {
          console.log('✅ Connected to Polymarket Market WebSocket');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit('connected');
          
          this.startPingInterval('market');
          
          // Resubscribe to previously subscribed assets
          for (const assetId of this.subscribedAssets) {
            this.subscribeToAsset(assetId);
          }
          
          resolve();
        });

        this.marketWs.on('message', (data: WebSocket.Data) => {
          this.handleMarketMessage(data);
        });

        this.marketWs.on('close', (code, reason) => {
          console.log(`Market WebSocket closed: ${code} - ${reason}`);
          this.isConnecting = false;
          this.stopPingInterval('market');
          this.emit('disconnected', { code, reason: reason.toString() });
          this.attemptReconnect('market');
        });

        this.marketWs.on('error', (error) => {
          console.error('Market WebSocket error:', error);
          this.isConnecting = false;
          this.emit('error', error);
          reject(error);
        });

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Connect to the authenticated user WebSocket
   */
  async connectUser(): Promise<void> {
    if (!this.hasCredentials()) {
      console.log('⚠️ No API credentials configured for user WebSocket');
      return;
    }

    if (this.userWs?.readyState === WebSocketCtor.OPEN || this.isUserConnecting) {
      console.log('User WebSocket already connected or connecting');
      return;
    }

    this.isUserConnecting = true;
    
    return new Promise((resolve, reject) => {
      try {
        console.log('🔐 Connecting to Polymarket User WebSocket...');
        
        // Generate authentication headers
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = this.generateSignature(timestamp, 'GET', '/ws/user');
        
        // Connect with auth headers
        this.userWs = new WebSocketCtor(WS_USER_URL, {
          headers: {
            'POLY_API_KEY': this.apiKey,
            'POLY_SIGNATURE': signature,
            'POLY_TIMESTAMP': timestamp.toString(),
            'POLY_PASSPHRASE': this.passphrase,
          },
        });

        this.userWs.on('open', () => {
          console.log('✅ Connected to Polymarket User WebSocket');
          this.isUserConnecting = false;
          this.emit('user_connected');
          
          this.startPingInterval('user');
          
          // Subscribe to user updates
          this.subscribeToUserUpdates();
          
          resolve();
        });

        this.userWs.on('message', (data: WebSocket.Data) => {
          this.handleUserMessage(data);
        });

        this.userWs.on('close', (code, reason) => {
          console.log(`User WebSocket closed: ${code} - ${reason}`);
          this.isUserConnecting = false;
          this.stopPingInterval('user');
          this.emit('user_disconnected', { code, reason: reason.toString() });
          this.attemptReconnect('user');
        });

        this.userWs.on('error', (error) => {
          console.error('User WebSocket error:', error);
          this.isUserConnecting = false;
          this.emit('user_error', error);
          reject(error);
        });

      } catch (error) {
        this.isUserConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Connect to both WebSockets
   */
  async connect(): Promise<void> {
    await this.connectMarket();
    
    // Try to connect user WebSocket if credentials are available
    if (this.hasCredentials()) {
      try {
        await this.connectUser();
      } catch (error) {
        console.error('Failed to connect user WebSocket:', error);
        // Don't fail the whole connection, market WS is still useful
      }
    }
  }

  /**
   * Subscribe to user updates (orders, trades)
   */
  private subscribeToUserUpdates(): void {
    if (this.userWs?.readyState !== WebSocketCtor.OPEN) {
      return;
    }

    // Subscribe to all user channels
    const channels = ['user'];
    
    for (const channel of channels) {
      const message = {
        auth: {
          apiKey: this.apiKey,
          secret: this.apiSecret,
          passphrase: this.passphrase,
        },
        type: 'subscribe',
        channel,
        markets: [], // Empty = all markets
      };
      
      this.userWs.send(JSON.stringify(message));
      console.log(`📡 Subscribed to user channel: ${channel}`);
    }
  }

  /**
   * Disconnect from all WebSockets
   */
  disconnect(): void {
    this.stopPingInterval('market');
    this.stopPingInterval('user');
    this.subscribedAssets.clear();
    
    if (this.marketWs) {
      this.marketWs.close();
      this.marketWs = null;
    }
    
    if (this.userWs) {
      this.userWs.close();
      this.userWs = null;
    }
  }

  /**
   * Subscribe to price updates for a specific asset
   */
  subscribeToAsset(assetId: string, conditionId?: string): void {
    if (conditionId) {
      this.assetToCondition.set(assetId, conditionId);
    }
    
    this.subscribedAssets.add(assetId);
    
    if (this.marketWs?.readyState !== WebSocketCtor.OPEN) {
      console.log(`Queued subscription for ${assetId} (WebSocket not connected)`);
      return;
    }

    // Correct Polymarket market WS subscribe payload
    const msg = {
      type: 'subscribe',
      channel: 'price',
      assets_ids: [assetId],
    };
    this.marketWs.send(JSON.stringify(msg));

    console.log(`📡 Subscribed (price channel) for ${assetId.slice(0, 16)}...`);
  }

  /**
   * Subscribe to multiple assets at once
   */
  subscribeToAssets(assetIds: string[]): void {
    for (const assetId of assetIds) {
      this.subscribedAssets.add(assetId);
    }
    
    if (this.marketWs?.readyState !== WebSocketCtor.OPEN) {
      console.log(`Queued ${assetIds.length} subscriptions (WebSocket not connected)`);
      return;
    }

    // Subscribe in batches of 100
    const batchSize = 100;
    for (let i = 0; i < assetIds.length; i += batchSize) {
      const batch = assetIds.slice(i, i + batchSize);
      const message = {
        type: 'subscribe',
        channel: 'price',
        assets_ids: batch,
      };
      this.marketWs.send(JSON.stringify(message));
    }
    
    console.log(`📡 Subscribed to ${assetIds.length} assets`);
  }

  /**
   * Unsubscribe from an asset
   */
  unsubscribeFromAsset(assetId: string): void {
    this.subscribedAssets.delete(assetId);
    
    if (this.marketWs?.readyState !== WebSocketCtor.OPEN) {
      return;
    }

    const message = {
      type: 'unsubscribe',
      channel: 'price',
      assets_ids: [assetId],
    };

    this.marketWs.send(JSON.stringify(message));
  }

  /**
   * Handle incoming market WebSocket messages
   */
  private handleMarketMessage(data: WebSocket.Data): void {
    const raw = data.toString();
    
    // Handle non-JSON messages (like "INVALID OPERATION")
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      // The market WS sometimes responds with a plain-text error for unsupported ops
      // We ignore it to avoid log spam (the connection is still healthy).
      if (raw === 'INVALID OPERATION') return;
      if (raw !== 'ping' && raw !== 'pong') {
        console.log(`Market WS non-JSON message: ${raw.slice(0, 100)}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;

      // Snapshot: array of orderbooks
      if (Array.isArray(parsed)) {
        for (const item of parsed as MarketBookSnapshotItem[]) {
          if (item && item.asset_id && Array.isArray(item.bids) && Array.isArray(item.asks)) {
            this.handleMarketBookSnapshot(item);
          }
        }
        return;
      }

      // Updates: price_changes batch
      const obj = parsed as Partial<MarketPriceChangesMessage> & Partial<WSMessage>;

      if (Array.isArray((obj as any).price_changes)) {
        this.handleMarketPriceChanges(obj as MarketPriceChangesMessage);
        return;
      }

      // Control messages (rare)
      if (typeof (obj as any).type === 'string') {
        const message = obj as WSMessage;
        if (message.type === 'subscribed') {
          console.log('✅ Market subscription confirmed');
          return;
        }
        if (message.type === 'error') {
          console.error('Market WebSocket error:', message);
          this.emit('error', message);
          return;
          }
      }
    } catch (error) {
      console.error('Failed to parse market message:', raw.slice(0, 200));
    }
  }

  /**
   * Handle incoming user WebSocket messages
   */
  private handleUserMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as WSMessage;
      
      // Polymarket sometimes sends uppercased types (e.g. "TRADE") — normalize.
      const msgType = String(message.type || '').toLowerCase();

      // Avoid log spam for high-frequency bots/benchmarks; log only unknowns.
      // console.log('📨 User WS message:', msgType, message);
      
      switch (msgType) {
        case 'order':
          this.handleUserOrderUpdate(message as unknown as UserOrderUpdate);
          break;
          
        case 'trade':
          this.handleUserTradeUpdate(message as unknown as UserTradeUpdate);
          break;
          
        case 'subscribed':
          console.log('✅ User subscription confirmed');
          this.emit('user_subscribed');
          break;
          
        case 'error':
          console.error('User WebSocket error message:', message);
          this.emit('user_error', message);
          break;
          
        default:
          if (msgType !== 'heartbeat' && msgType !== '') {
            console.log('Unknown user message type:', msgType, message);
          }
      }
    } catch (error) {
      console.error('Failed to parse user WebSocket message:', error);
    }
  }

  /**
   * Handle user order update messages
   */
  private handleUserOrderUpdate(update: UserOrderUpdate): void {
    const orderUpdate: RealtimeOrderUpdate = {
      orderId: update.id,
      assetId: update.asset_id,
      conditionId: this.assetToCondition.get(update.asset_id),
      side: update.side,
      status: update.status,
      originalSize: parseFloat(update.original_size),
      sizeMatched: parseFloat(update.size_matched),
      price: parseFloat(update.price),
      timestamp: new Date(update.timestamp),
      market: update.market,
      outcome: update.outcome,
    };
    
    console.log(`🔔 Order update: ${orderUpdate.side} ${orderUpdate.originalSize} @ ${orderUpdate.price} - ${orderUpdate.status}`);
    this.emit('order', orderUpdate);
  }

  /**
   * Handle user trade update messages (fills)
   */
  private handleUserTradeUpdate(update: UserTradeUpdate): void {
    const tradeUpdate: RealtimeTradeUpdate = {
      assetId: update.asset_id,
      conditionId: this.assetToCondition.get(update.asset_id),
      side: update.side,
      size: parseFloat(update.size),
      price: parseFloat(update.price),
      timestamp: new Date(update.timestamp),
      isOwn: true, // This is definitely the user's own trade
    };
    
    console.log(`💰 Trade filled: ${tradeUpdate.side} ${tradeUpdate.size} @ ${tradeUpdate.price}`);
    this.emit('user_trade', tradeUpdate);
    
    // Also emit as regular trade for the feed, but include order ids for latency benchmarking.
    this.emit('trade', {
      ...tradeUpdate,
      takerOrderId: (update as any).taker_order_id,
      makerOrderId: (update as any).maker_order_id,
      status: (update as any).status,
      market: (update as any).market,
      feeRateBps: (update as any).fee_rate_bps,
    });
  }

  private handleMarketBookSnapshot(item: MarketBookSnapshotItem): void {
    const bestBid = item.bids?.[0] ? parseFloat(item.bids[0].price) : undefined;
    const bestAsk = item.asks?.[0] ? parseFloat(item.asks[0].price) : undefined;

    const ts = Number(item.timestamp);
    const timestamp = Number.isFinite(ts) ? new Date(ts) : new Date();
    
    const priceUpdate: RealtimePriceUpdate = {
      assetId: item.asset_id,
      conditionId: this.assetToCondition.get(item.asset_id),
      price: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || 0,
      bestBid,
      bestAsk,
      timestamp,
    };
    
    this.emit('orderbook', priceUpdate);
  }

  private handleMarketPriceChanges(msg: MarketPriceChangesMessage): void {
    const ts = msg.timestamp ? Number(msg.timestamp) : NaN;
    const timestamp = Number.isFinite(ts) ? new Date(ts) : new Date();

    for (const ch of msg.price_changes || []) {
      const price = parseFloat(ch.price);
      const size = parseFloat(ch.size);
      const bestBid = ch.best_bid ? parseFloat(ch.best_bid) : undefined;
      const bestAsk = ch.best_ask ? parseFloat(ch.best_ask) : undefined;

      // Emit trade-like update (useful for lag analysis)
      if (Number.isFinite(price) && Number.isFinite(size)) {
        const tradeUpdate: RealtimeTradeUpdate = {
          assetId: ch.asset_id,
          conditionId: this.assetToCondition.get(ch.asset_id),
          side: ch.side,
          size,
          price,
          timestamp,
          isOwn: false,
        };
        this.emit('trade', tradeUpdate);
      }

      // Emit orderbook best bid/ask if present
      if (typeof bestBid === 'number' || typeof bestAsk === 'number') {
        const ob: RealtimePriceUpdate = {
          assetId: ch.asset_id,
          conditionId: this.assetToCondition.get(ch.asset_id),
          price: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk || price || 0,
          bestBid,
          bestAsk,
          timestamp,
        };
        this.emit('orderbook', ob);
      }
    }
  }

  /**
   * Attempt to reconnect after disconnect
   */
  private attemptReconnect(type: 'market' | 'user'): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Max reconnect attempts reached for ${type} WebSocket`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting ${type} WebSocket in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      if (type === 'market') {
        this.connectMarket().catch(console.error);
      } else {
        this.connectUser().catch(console.error);
      }
    }, delay);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(type: 'market' | 'user'): void {
    this.stopPingInterval(type);
    
    const interval = setInterval(() => {
      const ws = type === 'market' ? this.marketWs : this.userWs;
      if (ws?.readyState === WebSocketCtor.OPEN) {
        ws.ping();
      }
    }, 30000);
    
    if (type === 'market') {
      this.pingInterval = interval;
    } else {
      this.userPingInterval = interval;
    }
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(type: 'market' | 'user'): void {
    const interval = type === 'market' ? this.pingInterval : this.userPingInterval;
    if (interval) {
      clearInterval(interval);
      if (type === 'market') {
        this.pingInterval = null;
      } else {
        this.userPingInterval = null;
      }
    }
  }

  /**
   * Get market connection status
   */
  isConnected(): boolean {
    return this.marketWs?.readyState === WebSocketCtor.OPEN;
  }

  /**
   * Get user connection status
   */
  isUserConnected(): boolean {
    return this.userWs?.readyState === WebSocketCtor.OPEN;
  }

  /**
   * Get subscribed asset count
   */
  getSubscribedCount(): number {
    return this.subscribedAssets.size;
  }
}

// Singleton instance
let wsInstance: PolymarketWebSocket | null = null;

export function getPolymarketWS(): PolymarketWebSocket {
  if (!wsInstance) {
    wsInstance = new PolymarketWebSocket();
  }
  return wsInstance;
}

export function disconnectPolymarketWS(): void {
  if (wsInstance) {
    wsInstance.disconnect();
    wsInstance = null;
  }
}
