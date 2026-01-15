/**
 * BTC Price Service
 * 
 * Fetches real-time BTC/USD price from multiple sources:
 * - Chainlink (official resolution source for Polymarket BTC markets)
 * - CoinGecko (backup)
 * - Binance (backup, fastest)
 */

const CHAINLINK_BTC_USD = 'https://data.chain.link/streams/btc-usd';
const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const BINANCE_API = 'https://api.binance.com/api/v3';

export interface BTCPrice {
  price: number;
  timestamp: Date;
  source: 'chainlink' | 'coingecko' | 'binance';
}

class BTCPriceService {
  private cache: BTCPrice | null = null;
  private cacheTTL = 1000; // 1 second cache
  private lastFetch = 0;

  /**
   * Get current BTC/USD price
   * Tries Chainlink first (official Polymarket source), then fallbacks
   */
  async getPrice(): Promise<BTCPrice> {
    const now = Date.now();
    
    // Return cached if still fresh
    if (this.cache && (now - this.lastFetch) < this.cacheTTL) {
      return this.cache;
    }

    // Try Chainlink first (official source)
    try {
      const chainlinkPrice = await this.fetchChainlink();
      if (chainlinkPrice) {
        this.cache = chainlinkPrice;
        this.lastFetch = now;
        return chainlinkPrice;
      }
    } catch (error) {
      console.warn('Chainlink fetch failed:', error);
    }

    // Fallback to CoinGecko
    try {
      const coingeckoPrice = await this.fetchCoinGecko();
      if (coingeckoPrice) {
        this.cache = coingeckoPrice;
        this.lastFetch = now;
        return coingeckoPrice;
      }
    } catch (error) {
      console.warn('CoinGecko fetch failed:', error);
    }

    // Fallback to Binance (fastest)
    try {
      const binancePrice = await this.fetchBinance();
      if (binancePrice) {
        this.cache = binancePrice;
        this.lastFetch = now;
        return binancePrice;
      }
    } catch (error) {
      console.warn('Binance fetch failed:', error);
    }

    // If all fail, return cached or throw
    if (this.cache) {
      console.warn('All price sources failed, using stale cache');
      return this.cache;
    }

    throw new Error('All BTC price sources failed');
  }

  /**
   * Fetch from Chainlink BTC/USD stream
   * This is the official resolution source for Polymarket BTC markets
   */
  private async fetchChainlink(): Promise<BTCPrice | null> {
    try {
      // Chainlink streams API endpoint
      const response = await fetch(CHAINLINK_BTC_USD, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      
      // Chainlink streams format may vary, try common fields
      const price = parseFloat(
        data.price || 
        data.value || 
        data.latestAnswer || 
        data.data?.price ||
        '0'
      );

      if (price > 0 && price < 1000000) { // Sanity check
        return {
          price,
          timestamp: new Date(),
          source: 'chainlink',
        };
      }
    } catch (error) {
      console.error('Chainlink fetch error:', error);
    }

    return null;
  }

  /**
   * Fetch from CoinGecko
   */
  private async fetchCoinGecko(): Promise<BTCPrice | null> {
    try {
      const response = await fetch(
        `${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`,
        {
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const price = data.bitcoin?.usd;

      if (price && price > 0) {
        return {
          price,
          timestamp: new Date(),
          source: 'coingecko',
        };
      }
    } catch (error) {
      console.error('CoinGecko fetch error:', error);
    }

    return null;
  }

  /**
   * Fetch from Binance (fastest, good backup)
   */
  private async fetchBinance(): Promise<BTCPrice | null> {
    try {
      const response = await fetch(`${BINANCE_API}/ticker/price?symbol=BTCUSDT`, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const price = parseFloat(data.price);

      if (price && price > 0) {
        return {
          price,
          timestamp: new Date(),
          source: 'binance',
        };
      }
    } catch (error) {
      console.error('Binance fetch error:', error);
    }

    return null;
  }

  /**
   * Get price with retry logic
   */
  async getPriceWithRetry(maxRetries = 3): Promise<BTCPrice> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.getPrice();
      } catch (error) {
        if (i === maxRetries - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error('Failed to fetch BTC price after retries');
  }
}

// Singleton instance
export const btcPriceService = new BTCPriceService();
