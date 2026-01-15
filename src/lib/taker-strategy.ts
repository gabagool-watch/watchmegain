/**
 * Taker Strategy Logic
 * 
 * Determines when to place taker orders based on:
 * - BTC price vs market price
 * - Expected value calculation
 * - Risk management
 */

import { BTCPrice } from './btc-price';
import { BTC15mMarket } from './market-discovery';

export interface TradingSignal {
  action: 'BUY_UP' | 'BUY_DOWN' | 'SELL_UP' | 'SELL_DOWN' | 'HOLD';
  assetId: string;
  side: 'BUY' | 'SELL';
  size: number;
  marketPrice: number;
  fairValue: number;
  edge: number; // Expected profit in basis points
  confidence: number; // 0-1
  reason: string;
}

export interface OrderBookSnapshot {
  assetId: string;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  midPrice: number;
}

export class TakerStrategy {
  private minEdgeBps: number; // Minimum edge in basis points to trade
  private maxSizeUSD: number; // Maximum order size in USD
  private maxPositionUSD: number; // Maximum total position size

  constructor(config?: {
    minEdgeBps?: number;
    maxSizeUSD?: number;
    maxPositionUSD?: number;
  }) {
    this.minEdgeBps = config?.minEdgeBps || 50; // Default: 0.5% edge
    this.maxSizeUSD = config?.maxSizeUSD || 100; // Default: $100 max per order
    this.maxPositionUSD = config?.maxPositionUSD || 500; // Default: $500 max position
  }

  /**
   * Calculate fair value for UP token based on BTC price movement
   * 
   * For a BTC 15m Up/Down market:
   * - Market resolves to UP if BTC price at end >= BTC price at start
   * - Market resolves to DOWN if BTC price at end < BTC price at start
   * 
   * Fair value = probability that BTC will be UP at end time
   */
  calculateFairValue(
    btcPrice: BTCPrice,
    market: BTC15mMarket,
    startPrice?: number
  ): { upFairValue: number; downFairValue: number; reason: string } {
    const now = new Date();
    const timeRemaining = market.endTime.getTime() - now.getTime();
    const timeElapsed = now.getTime() - market.startTime.getTime();
    const totalDuration = 15 * 60 * 1000; // 15 minutes

    // If we don't have start price, we can't calculate fair value accurately
    // In that case, assume 50/50 (no edge)
    if (!startPrice) {
      return {
        upFairValue: 0.5,
        downFairValue: 0.5,
        reason: 'No start price available, assuming 50/50',
      };
    }

    const currentPrice = btcPrice.price;
    const priceChange = currentPrice - startPrice;
    const priceChangePct = (priceChange / startPrice) * 100;

    // Simple model: if BTC is already up, UP is more likely
    // If BTC is already down, DOWN is more likely
    // Adjust based on time remaining
    
    const progress = Math.max(0, Math.min(1, timeElapsed / totalDuration));
    const timeWeight = 1 - progress; // More weight to remaining time

    // If BTC is already up X%, and we're Y% through the period,
    // the probability of ending up is higher
    let upProbability = 0.5; // Base: 50/50

    if (priceChangePct > 0) {
      // BTC is up, so UP is more likely
      // But we need to account for volatility - BTC could reverse
      upProbability = 0.5 + (priceChangePct / 100) * timeWeight * 0.5;
      upProbability = Math.max(0.1, Math.min(0.9, upProbability)); // Clamp to 10-90%
    } else if (priceChangePct < 0) {
      // BTC is down, so DOWN is more likely
      upProbability = 0.5 + (priceChangePct / 100) * timeWeight * 0.5;
      upProbability = Math.max(0.1, Math.min(0.9, upProbability));
    }

    const downProbability = 1 - upProbability;

    return {
      upFairValue: upProbability,
      downFairValue: downProbability,
      reason: `BTC ${priceChangePct > 0 ? 'up' : 'down'} ${Math.abs(priceChangePct).toFixed(2)}%, ${(progress * 100).toFixed(0)}% through period`,
    };
  }

  /**
   * Generate trading signal based on market prices and fair value
   */
  generateSignal(
    market: BTC15mMarket,
    upOrderBook: OrderBookSnapshot,
    downOrderBook: OrderBookSnapshot,
    upFairValue: number,
    downFairValue: number,
    currentPositions?: { up: number; down: number } // Current position sizes
  ): TradingSignal | null {
    // Calculate edge for UP token
    const upMarketPrice = upOrderBook.midPrice;
    const upEdge = (upFairValue - upMarketPrice) * 10000; // Convert to basis points
    const upEdgeAbs = Math.abs(upEdge);

    // Calculate edge for DOWN token
    const downMarketPrice = downOrderBook.midPrice;
    const downEdge = (downFairValue - downMarketPrice) * 10000;
    const downEdgeAbs = Math.abs(downEdge);

    // Check if we have enough edge
    const hasUpEdge = upEdgeAbs >= this.minEdgeBps;
    const hasDownEdge = downEdgeAbs >= this.minEdgeBps;

    // Check position limits
    const currentUpPosition = currentPositions?.up || 0;
    const currentDownPosition = currentPositions?.down || 0;
    const totalPosition = Math.abs(currentUpPosition) + Math.abs(currentDownPosition);

    // Determine best opportunity
    if (hasUpEdge && upEdge > 0 && totalPosition < this.maxPositionUSD) {
      // UP is undervalued, buy UP
      const size = Math.min(this.maxSizeUSD, this.maxPositionUSD - totalPosition);
      return {
        action: 'BUY_UP',
        assetId: market.upTokenId,
        side: 'BUY',
        size,
        marketPrice: upMarketPrice,
        fairValue: upFairValue,
        edge: upEdge,
        confidence: Math.min(1, upEdgeAbs / 200), // Higher edge = higher confidence
        reason: `UP undervalued by ${upEdge.toFixed(0)} bps`,
      };
    } else if (hasUpEdge && upEdge < 0 && currentUpPosition > 0) {
      // UP is overvalued, sell UP if we have position
      const size = Math.min(this.maxSizeUSD, currentUpPosition);
      return {
        action: 'SELL_UP',
        assetId: market.upTokenId,
        side: 'SELL',
        size,
        marketPrice: upMarketPrice,
        fairValue: upFairValue,
        edge: -upEdge,
        confidence: Math.min(1, upEdgeAbs / 200),
        reason: `UP overvalued by ${upEdgeAbs.toFixed(0)} bps, taking profit`,
      };
    } else if (hasDownEdge && downEdge > 0 && totalPosition < this.maxPositionUSD) {
      // DOWN is undervalued, buy DOWN
      const size = Math.min(this.maxSizeUSD, this.maxPositionUSD - totalPosition);
      return {
        action: 'BUY_DOWN',
        assetId: market.downTokenId,
        side: 'BUY',
        size,
        marketPrice: downMarketPrice,
        fairValue: downFairValue,
        edge: downEdge,
        confidence: Math.min(1, downEdgeAbs / 200),
        reason: `DOWN undervalued by ${downEdgeAbs.toFixed(0)} bps`,
      };
    } else if (hasDownEdge && downEdge < 0 && currentDownPosition > 0) {
      // DOWN is overvalued, sell DOWN if we have position
      const size = Math.min(this.maxSizeUSD, currentDownPosition);
      return {
        action: 'SELL_DOWN',
        assetId: market.downTokenId,
        side: 'SELL',
        size,
        marketPrice: downMarketPrice,
        fairValue: downFairValue,
        edge: -downEdge,
        confidence: Math.min(1, downEdgeAbs / 200),
        reason: `DOWN overvalued by ${downEdgeAbs.toFixed(0)} bps, taking profit`,
      };
    }

    // No signal
    return {
      action: 'HOLD',
      assetId: '',
      side: 'BUY',
      size: 0,
      marketPrice: 0,
      fairValue: 0,
      edge: 0,
      confidence: 0,
      reason: `No edge (min ${this.minEdgeBps} bps required, UP: ${upEdge.toFixed(0)}, DOWN: ${downEdge.toFixed(0)})`,
    };
  }

  /**
   * Get orderbook snapshot for an asset
   */
  async getOrderBookSnapshot(assetId: string): Promise<OrderBookSnapshot | null> {
    try {
      const response = await fetch(
        `${process.env.POLYMARKET_CLOB_API || 'https://clob.polymarket.com'}/book?asset_id=${assetId}`,
        {
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        return null;
      }

      const book = await response.json();
      
      const bestBid = book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0;
      const bestAsk = book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
      const bidSize = book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].size) : 0;
      const askSize = book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].size) : 0;
      const midPrice = (bestBid + bestAsk) / 2;

      return {
        assetId,
        bestBid,
        bestAsk,
        bidSize,
        askSize,
        midPrice,
      };
    } catch (error) {
      console.error('Failed to get orderbook:', error);
      return null;
    }
  }
}
