/**
 * Market Discovery for BTC 15m Up/Down Markets
 * 
 * Finds and tracks active BTC 15-minute Up/Down markets on Polymarket
 */

import { PolymarketMarketSource } from './providers/polymarket-provider';

const GAMMA_MARKETS_API = process.env.GAMMA_MARKETS_API || 'https://gamma-api.polymarket.com';

export interface BTC15mMarket {
  conditionId: string;
  question: string;
  slug: string;
  startTime: Date; // From slug timestamp (15m boundary)
  endTime: Date;   // startTime + 15 minutes
  upTokenId: string;
  downTokenId: string;
  upPrice?: number;
  downPrice?: number;
  volume?: number;
  isActive: boolean;
}

export class BTC15mMarketDiscovery {
  private marketSource: PolymarketMarketSource;
  private cache: Map<string, BTC15mMarket> = new Map();
  private cacheTTL = 60000; // 1 minute cache
  private lastFetch = 0;

  constructor() {
    this.marketSource = new PolymarketMarketSource();
  }

  /**
   * Find the currently active BTC 15m market
   * BTC 15m markets follow pattern: "Bitcoin Up or Down - [Date] [Time]-[Time+15m] ET"
   */
  async findActiveMarket(): Promise<BTC15mMarket | null> {
    const now = Date.now();
    
    // Check cache
    if (now - this.lastFetch < this.cacheTTL) {
      const cached = Array.from(this.cache.values()).find(m => m.isActive);
      if (cached) {
        return cached;
      }
    }

    try {
      // Search for BTC markets
      const markets = await this.searchBTCMarkets();
      
      // Find the active one (current time is between start and end)
      const activeMarket = markets.find(m => {
        const nowDate = new Date();
        return nowDate >= m.startTime && nowDate <= m.endTime;
      });

      // Update cache
      this.cache.clear();
      markets.forEach(m => this.cache.set(m.conditionId, m));
      this.lastFetch = now;

      if (activeMarket) {
        console.log(`✅ Found active BTC 15m market: ${activeMarket.question}`);
        console.log(`   End time: ${activeMarket.endTime.toISOString()}`);
        return activeMarket;
      }

      // If no active market, find the next upcoming one
      const upcomingMarkets = markets
        .filter(m => m.startTime > new Date())
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

      if (upcomingMarkets.length > 0) {
        console.log(`⏳ Next BTC 15m market starts: ${upcomingMarkets[0].startTime.toISOString()}`);
        console.log(`   Using upcoming market: ${upcomingMarkets[0].question}`);
        return upcomingMarkets[0];
      }

      // Fallback: use the most recent market (even if it just ended)
      if (markets.length > 0) {
        const recentMarkets = markets
          .sort((a, b) => b.endTime.getTime() - a.endTime.getTime());
        
        const mostRecent = recentMarkets[0];
        console.log(`⚠️ No active market found, using most recent: ${mostRecent.question}`);
        console.log(`   End time was: ${mostRecent.endTime.toISOString()}`);
        return mostRecent;
      }

      console.log('⚠️ No BTC 15m markets found at all');
      return null;
    } catch (error) {
      console.error('Failed to find active BTC market:', error);
      return null;
    }
  }

  /**
   * Search for BTC 15m markets
   * Uses exact slug query: btc-updown-15m-{timestamp}
   */
  private async searchBTCMarkets(): Promise<BTC15mMarket[]> {
    const markets: BTC15mMarket[] = [];

    try {
      console.log('🔍 Fetching BTC 15m markets...');
      
      // Generate timestamps for current and upcoming 15m windows
      // Polymarket uses Unix timestamps rounded to 15-minute intervals
      const now = Math.floor(Date.now() / 1000);
      const windowSize = 15 * 60; // 15 minutes
      
      // Try windows: -1 (previous), 0 (current), +1 (next), +2, +3
      for (let i = -1; i <= 3; i++) {
        const windowStart = Math.floor(now / windowSize) * windowSize + (i * windowSize);
        const slug = `btc-updown-15m-${windowStart}`;
        
        try {
          const response = await fetch(
            `${GAMMA_MARKETS_API}/markets?slug=${slug}`,
            { headers: { 'Accept': 'application/json' } }
          );
          
          if (response.ok) {
            const data = await response.json();
            const marketData = Array.isArray(data) ? data[0] : data;
            
            if (marketData && (marketData.condition_id || marketData.conditionId)) {
              const parsed = this.parseMarket(marketData);
              if (parsed && !markets.find(m => m.conditionId === parsed.conditionId)) {
                markets.push(parsed);
                console.log(`   ✅ ${parsed.question}`);
              }
            }
          }
        } catch (e) {
          // Continue to next timestamp
        }
      }

      console.log(`📊 Found ${markets.length} BTC 15m markets`);
      return markets;
    } catch (error) {
      console.error('❌ Failed:', error);
      return [];
    }
  }

  /**
   * Parse a Gamma API market into BTC15mMarket format
   * NOTE: outcomes and clobTokenIds are JSON STRINGS, not arrays!
   */
  private parseMarket(market: any): BTC15mMarket | null {
    try {
      const conditionId = market.condition_id || market.conditionId;
      if (!conditionId) {
        return null;
      }

      // Parse JSON strings to arrays
      let outcomes: string[];
      let tokenIds: string[];

      try {
        outcomes = typeof market.outcomes === 'string' 
          ? JSON.parse(market.outcomes) 
          : market.outcomes;
        tokenIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds;
      } catch {
        console.log(`  ⚠️ Failed to parse outcomes/tokenIds for ${conditionId}`);
        return null;
      }

      if (!outcomes?.length || !tokenIds?.length || outcomes.length < 2 || tokenIds.length < 2) {
        return null;
      }

      // Map outcomes to token IDs
      let upTokenId: string | null = null;
      let downTokenId: string | null = null;

      outcomes.forEach((outcome: string, i: number) => {
        const o = outcome.toLowerCase();
        if (o === 'up' || o === 'yes') {
          upTokenId = tokenIds[i];
        } else if (o === 'down' || o === 'no') {
          downTokenId = tokenIds[i];
        }
      });

      if (!upTokenId || !downTokenId) {
        return null;
      }

      // Parse start time from slug (btc-updown-15m-{timestamp})
      // NOTE: The slug timestamp is the 15m boundary (start of the market window).
      const slugMatch = market.slug?.match(/btc-updown-15m-(\d+)/);
      let startTime: Date;
      
      if (slugMatch) {
        // Slug contains exact window start timestamp
        startTime = new Date(parseInt(slugMatch[1]) * 1000);
      } else {
        // Fallback to endDateIso (less reliable)
        const endTimeStr = market.endDateIso || market.end_date_iso;
        const approxEnd = endTimeStr ? new Date(endTimeStr) : new Date();
        startTime = new Date(approxEnd.getTime() - 15 * 60 * 1000);
      }

      const endTime = new Date(startTime.getTime() + 15 * 60 * 1000);
      const now = new Date();
      const isActive = now >= startTime && now <= endTime;

      return {
        conditionId,
        question: market.question || 'Unknown',
        slug: market.slug || '',
        startTime,
        endTime,
        upTokenId,
        downTokenId,
        isActive,
      };
    } catch (error) {
      console.error(`  ❌ Failed to parse market:`, error);
      return null;
    }
  }

  /**
   * Get market by condition ID
   */
  async getMarket(conditionId: string): Promise<BTC15mMarket | null> {
    // Check cache first
    if (this.cache.has(conditionId)) {
      return this.cache.get(conditionId)!;
    }

    // Fetch from API
    try {
      const market = await this.marketSource.fetchMarket(conditionId);
      if (!market) {
        return null;
      }

      // Convert to BTC15mMarket format
      const btcMarket: BTC15mMarket = {
        conditionId: market.conditionId,
        question: market.title,
        slug: '',
        startTime: market.endTime
          ? new Date(market.endTime.getTime() - 15 * 60 * 1000)
          : new Date(),
        endTime: market.endTime || new Date(),
        upTokenId: market.outcomes[0]?.tokenId || '',
        downTokenId: market.outcomes[1]?.tokenId || '',
        isActive: market.status === 'OPEN',
      };

      this.cache.set(conditionId, btcMarket);
      return btcMarket;
    } catch (error) {
      console.error('Failed to get market:', error);
      return null;
    }
  }
}

// Singleton instance
export const btc15mMarketDiscovery = new BTC15mMarketDiscovery();
