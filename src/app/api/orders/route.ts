/**
 * API endpoint to fetch open orders from Polymarket CLOB API
 * 
 * GET /api/orders
 * Returns: List of open orders for the authenticated wallet
 */

import { NextResponse } from 'next/server';
import crypto from 'crypto';

const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Get credentials from env
const API_KEY = process.env.POLYMARKET_API_KEY || '';
const API_SECRET = process.env.POLYMARKET_API_SECRET || '';
const PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE || '';

function generateSignature(timestamp: number, method: string, path: string, body: string = ''): string {
  const message = `${timestamp}${method}${path}${body}`;
  const hmac = crypto.createHmac('sha256', Buffer.from(API_SECRET, 'base64'));
  hmac.update(message);
  return hmac.digest('base64');
}

interface ClobOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  original_size: string;
  size_matched: string;
  price: string;
  status: string;
  created_at: string;
  expiration?: string;
  outcome?: string;
}

interface MarketInfo {
  question?: string;
  slug?: string;
  end_date_iso?: string;
}

// Cache market info to avoid repeated API calls
const marketCache = new Map<string, MarketInfo>();

async function getMarketInfo(assetId: string): Promise<MarketInfo | null> {
  if (marketCache.has(assetId)) {
    return marketCache.get(assetId)!;
  }

  try {
    // Try to get market by token_id
    const response = await fetch(`${GAMMA_API}/markets?token_id=${assetId}`);
    if (response.ok) {
      const markets = await response.json();
      if (markets && markets.length > 0) {
        const market = markets[0];
        const info: MarketInfo = {
          question: market.question,
          slug: market.slug,
          end_date_iso: market.end_date_iso,
        };
        marketCache.set(assetId, info);
        return info;
      }
    }
  } catch (e) {
    console.error('Failed to fetch market info:', e);
  }
  
  return null;
}

export async function GET() {
  // Check if we have credentials
  if (!API_KEY || !API_SECRET || !PASSPHRASE) {
    return NextResponse.json({ 
      error: 'API credentials not configured',
      hasKey: !!API_KEY,
      hasSecret: !!API_SECRET,
      hasPassphrase: !!PASSPHRASE,
    }, { status: 400 });
  }

  try {
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
      const text = await response.text();
      console.error('CLOB API error:', response.status, text);
      return NextResponse.json({ 
        error: 'Failed to fetch orders',
        status: response.status,
        details: text,
      }, { status: response.status });
    }

    const orders: ClobOrder[] = await response.json();
    
    // Filter to only LIVE (open) orders
    const openOrders = orders.filter(o => o.status === 'LIVE' || o.status === 'OPEN');

    // Enrich with market info
    const enrichedOrders = await Promise.all(
      openOrders.map(async (order) => {
        const marketInfo = await getMarketInfo(order.asset_id);
        
        return {
          id: order.id,
          assetId: order.asset_id,
          side: order.side,
          originalSize: parseFloat(order.original_size),
          sizeMatched: parseFloat(order.size_matched || '0'),
          price: parseFloat(order.price),
          status: order.status,
          createdAt: order.created_at,
          expiration: order.expiration,
          market: marketInfo?.question || order.market || `Asset ${order.asset_id.slice(0, 8)}...`,
          marketSlug: marketInfo?.slug,
          marketEndTime: marketInfo?.end_date_iso,
          outcome: order.outcome,
        };
      })
    );

    return NextResponse.json({
      orders: enrichedOrders,
      total: enrichedOrders.length,
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : 'Failed to fetch orders',
    }, { status: 500 });
  }
}
