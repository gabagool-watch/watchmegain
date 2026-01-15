/**
 * Order Placement Service
 * 
 * Places taker orders on Polymarket CLOB
 */

import '@/lib/env/bootstrap';
import crypto from 'crypto';
import { enableHttpKeepAlive } from '@/lib/http/keepalive';

const CLOB_API = process.env.POLYMARKET_CLOB_API || 'https://clob.polymarket.com';

// Get credentials from env
const API_KEY = process.env.POLYMARKET_API_KEY || '';
const API_SECRET = process.env.POLYMARKET_API_SECRET || '';
const PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE || '';
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '';
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || '137');
const MIN_EXPIRY_LEEWAY_SEC = Number(process.env.POLYMARKET_MIN_EXPIRY_LEEWAY_SEC || '75');

// Reduce request latency by reusing TCP/TLS connections (optional)
enableHttpKeepAlive();

export interface TakerOrder {
  assetId: string;
  side: 'BUY' | 'SELL';
  size: number; // Size in USD
  price?: number; // Optional: if not provided, will use best bid/ask
  marketType?: 'MARKET' | 'LIMIT'; // Default: MARKET (taker)
}

export interface LimitOrder {
  assetId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  /**
   * If true, the order must rest on the book (maker). If it would cross/spread-match, it should be rejected.
   * Note: a LIMIT that crosses is effectively a taker and may still be subject to taker latency/throttling.
   */
  postOnly?: boolean;
  /** Expiration seconds since epoch (default: now+3600) */
  expiration?: number;
}

export interface OrderResponse {
  orderId: string;
  status: string;
  assetId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  filled?: number;
  timestamp: Date;
}

function normalizeBase64(input: string): string {
  // Convert base64url to base64 and strip any invalid chars (matches Polymarket reference client behavior)
  return input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');
}

function toUrlSafeBase64(b64: string): string {
  // NOTE: Must be url safe base64 encoding, but keep base64 "=" suffix
  return b64.replace(/\+/g, '-').replace(/\//g, '_');
}

function generateSignature(timestamp: number, method: string, path: string, body?: string): string {
  let message = `${timestamp}${method}${path}`;
  if (body !== undefined) message += body;

  const secretKey = Buffer.from(normalizeBase64(API_SECRET), 'base64');
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(message);
  return toUrlSafeBase64(hmac.digest('base64'));
}

export class OrderPlacementService {
  private clobPromise: Promise<{
    client: any;
    Side: any;
    OrderType: any;
    SignatureType: any;
  }> | null = null;

  private async getClob() {
    if (this.clobPromise) return this.clobPromise;
    this.clobPromise = (async () => {
      if (!PRIVATE_KEY) {
        throw new Error(
          'Missing POLYMARKET_PRIVATE_KEY. Polymarket order placement requires signing orders with your wallet private key.',
        );
      }
      if (!API_KEY || !API_SECRET || !PASSPHRASE) {
        throw new Error('Missing Polymarket API credentials (POLYMARKET_API_KEY/SECRET/PASSPHRASE).');
      }

      let clobMod: any;
      let walletMod: any;
      let orderUtilsMod: any;
      try {
        // Dynamic imports so the repo still compiles before you run `npm install`
        clobMod = await import('@polymarket/clob-client');
        walletMod = await import('@ethersproject/wallet');
        orderUtilsMod = await import('@polymarket/order-utils');
      } catch (e) {
        throw new Error(
          'Missing Polymarket trading deps. Run: `npm install` (adds @polymarket/clob-client + ethers).',
        );
      }

      const { ClobClient, Side, OrderType } = clobMod;
      const { Wallet } = walletMod;
      const { SignatureType } = orderUtilsMod;

      const signer = new Wallet(PRIVATE_KEY);
      const funder = (process.env.POLYMARKET_ADDRESS || signer.address).toLowerCase();

      let signatureType = SignatureType.GNOSIS_SAFE;
      const sigTypeEnv = process.env.POLYMARKET_SIGNATURE_TYPE;
      if (sigTypeEnv) {
        signatureType = Number(sigTypeEnv);
      } else {
        // If the funder address equals the signer address, assume a standard EOA.
        signatureType = funder === signer.address.toLowerCase() ? SignatureType.EOA : SignatureType.GNOSIS_SAFE;
      }

      // Guard rail: EOA signature type only makes sense if the funder is the EOA itself.
      // If user configured/left EOA but funder != signer, Polymarket will reject with "invalid signature".
      if (signatureType === SignatureType.EOA && funder !== signer.address.toLowerCase()) {
        console.warn(
          `[order-placement] POLYMARKET_SIGNATURE_TYPE=EOA but POLYMARKET_ADDRESS (${funder}) != signer (${signer.address}). ` +
            `Overriding signatureType to GNOSIS_SAFE (2). Set POLYMARKET_SIGNATURE_TYPE explicitly if you need POLY_PROXY (1).`,
        );
        signatureType = SignatureType.GNOSIS_SAFE;
      }

      const creds = { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE };
      // useServerTime=true helps avoid local clock skew issues (especially for expiration threshold)
      const client = new ClobClient(CLOB_API, CHAIN_ID, signer, creds, signatureType, funder, undefined, true);
      return { client, Side, OrderType, SignatureType };
    })();
    return this.clobPromise;
  }

  /**
   * Check if we have valid credentials
   */
  hasCredentials(): boolean {
    // Note: placing orders requires both L2 creds and a wallet private key to sign the on-chain order object.
    return !!(API_KEY && API_SECRET && PASSPHRASE && PRIVATE_KEY);
  }

  /**
   * Place a taker order (market order that crosses the spread)
   */
  async placeTakerOrder(order: TakerOrder): Promise<OrderResponse> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }

    // For market orders, we need to get the best bid/ask first
    let price = order.price;
    if (!price || order.marketType === 'MARKET') {
      const bestPrice = await this.getBestPrice(order.assetId, order.side);
      if (!bestPrice) {
        throw new Error(`No liquidity available for ${order.assetId}`);
      }
      price = bestPrice;
    }

    // Build order payload
    // Polymarket "taker" is still a limit order that crosses the book. Use the official clob-client to sign.
    const { client, Side, OrderType } = await this.getClob();
    const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

    // Marketable BUY: interpret `size` as USD and convert to shares at the chosen price.
    const shares = order.side === 'BUY' ? order.size / price : order.size;
    const nonce = Date.now();
    const nowSec = Math.floor(Date.now() / 1000);
    const expiration = nowSec + Math.max(60, MIN_EXPIRY_LEEWAY_SEC);

    const resp = await client.createAndPostOrder(
      {
        tokenID: order.assetId,
        price,
        size: shares,
        side,
        nonce,
        expiration,
      },
      undefined,
      OrderType.GTD,
      false,
      false,
    );

    if (resp?.success === false) {
      throw new Error(`Order placement failed: ${resp.errorMsg || 'unknown error'}`);
    }

    return {
      orderId: String(resp?.orderID || ''),
      status: String(resp?.status || 'PENDING'),
      assetId: order.assetId,
      side: order.side,
      size: order.size,
      price,
      timestamp: new Date(),
    };
  }

  /**
   * Place a limit order (optionally post-only / maker).
   */
  async placeLimitOrder(order: LimitOrder): Promise<OrderResponse> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }
    if (!Number.isFinite(order.price) || order.price <= 0 || order.price >= 1) {
      throw new Error(`Invalid price ${order.price}. Expected 0 < price < 1`);
    }
    if (!Number.isFinite(order.size) || order.size <= 0) {
      throw new Error(`Invalid size ${order.size}`);
    }

    const { client, Side, OrderType } = await this.getClob();
    const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

    // For BUY orders in our bots/scripts we treat `size` as USD. Convert to shares.
    // (For SELL, you usually think in shares.)
    const shares = order.side === 'BUY' ? order.size / order.price : order.size;
    const nonce = Date.now();
    const nowSec = Math.floor(Date.now() / 1000);
    const expiration =
      order.expiration != null
        ? Math.max(order.expiration, nowSec + Math.max(60, MIN_EXPIRY_LEEWAY_SEC))
        : undefined;
    const orderType = expiration ? OrderType.GTD : OrderType.GTC;

    const resp = await client.createAndPostOrder(
      {
        tokenID: order.assetId,
        price: order.price,
        size: shares,
        side,
        nonce,
        expiration,
      },
      undefined,
      orderType,
      false,
      order.postOnly ?? true,
    );

    if (resp?.success === false) {
      throw new Error(`Order placement failed: ${resp.errorMsg || 'unknown error'}`);
    }

    return {
      orderId: String(resp?.orderID || ''),
      status: String(resp?.status || 'PENDING'),
      assetId: order.assetId,
      side: order.side,
      size: order.size,
      price: order.price,
      timestamp: new Date(),
    };
  }

  /**
   * Get best bid or ask price for an asset
   */
  private async getBestPrice(assetId: string, side: 'BUY' | 'SELL'): Promise<number | null> {
    try {
      // Fetch orderbook snapshot
      const response = await fetch(`${CLOB_API}/book?asset_id=${assetId}`, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const book = await response.json();
      
      if (side === 'BUY') {
        // Buying: we need the best ask (lowest price)
        const asks = book.asks || [];
        if (asks.length > 0) {
          return parseFloat(asks[0].price);
        }
      } else {
        // Selling: we need the best bid (highest price)
        const bids = book.bids || [];
        if (bids.length > 0) {
          return parseFloat(bids[0].price);
        }
      }

      return null;
    } catch (error) {
      console.error('Failed to get best price:', error);
      return null;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<void> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const path = `/orders/${orderId}`;
    const signature = generateSignature(timestamp, 'DELETE', path);

    const response = await fetch(`${CLOB_API}${path}`, {
      method: 'DELETE',
      headers: {
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp.toString(),
        'POLY_PASSPHRASE': PASSPHRASE,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cancel failed: ${response.status} - ${errorText}`);
    }

    console.log(`✅ Order cancelled: ${orderId}`);
  }

  /**
   * Cancel multiple orders in a single request (L2).
   *
   * Docs: DELETE /<clob-endpoint>/orders with JSON body: ["orderId1","orderId2",...]
   */
  async cancelOrdersL2(orderIds: string[]): Promise<{ canceled: string[]; not_canceled?: Record<string, string> }> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }
    const ids = Array.from(new Set(orderIds)).filter(Boolean);
    if (ids.length === 0) return { canceled: [] };

    const { client } = await this.getClob();
    return await client.cancelOrders(ids);
  }

  /**
   * Cancel all open orders for this API user (L2).
   *
   * Docs: DELETE /<clob-endpoint>/cancel-all
   */
  async cancelAll(): Promise<{ canceled: string[]; not_canceled?: Record<string, string> }> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }
    const { client } = await this.getClob();
    return await client.cancelAll();
  }

  /**
   * Cancel orders from a given market and/or asset (L2).
   *
   * Docs: DELETE /<clob-endpoint>/cancel-market-orders with JSON body { market?, asset_id? }
   */
  async cancelMarketOrders(params: { market?: string; assetId?: string }): Promise<{ canceled: string[]; not_canceled?: Record<string, string> }> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }
    const { client } = await this.getClob();
    const payload: any = {};
    if (params.market) payload.market = params.market;
    if (params.assetId) payload.asset_id = params.assetId;
    return await client.cancelMarketOrders(payload);
  }

  /**
   * Cancel multiple orders with bounded concurrency.
   */
  async cancelOrders(orderIds: string[], concurrency: number = 5): Promise<void> {
    const ids = Array.from(new Set(orderIds)).filter(Boolean);
    if (ids.length === 0) return;

    // Prefer one-shot L2 cancel endpoint (fewer round trips)
    try {
      await this.cancelOrdersL2(ids);
      return;
    } catch (e) {
      // Fall back to per-order cancel if batch cancel fails (endpoint differences / transient errors)
      console.error('cancelOrdersL2 failed, falling back to per-order cancels:', e instanceof Error ? e.message : e);
    }

    let idx = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, async () => {
      while (idx < ids.length) {
        const my = ids[idx++];
        try {
          await this.cancelOrder(my);
        } catch (e) {
          console.error(`Failed to cancel ${my}:`, e);
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<OrderResponse[]> {
    if (!this.hasCredentials()) {
      throw new Error('Missing Polymarket API credentials');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/orders';
    const signature = generateSignature(timestamp, 'GET', path);

    const response = await fetch(`${CLOB_API}${path}`, {
      method: 'GET',
      headers: {
        'POLY_API_KEY': API_KEY,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp.toString(),
        'POLY_PASSPHRASE': PASSPHRASE,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch orders: ${response.status} - ${errorText}`);
    }

    const orders = await response.json();
    
    return orders
      .filter((o: any) => o.status === 'LIVE' || o.status === 'OPEN')
      .map((o: any) => ({
        orderId: o.id,
        status: o.status,
        assetId: o.asset_id,
        side: o.side,
        size: parseFloat(o.original_size),
        price: parseFloat(o.price),
        filled: parseFloat(o.size_matched || '0'),
        timestamp: new Date(o.created_at),
      }));
  }
}

// Singleton instance
export const orderPlacementService = new OrderPlacementService();
