/**
 * Mock Data Provider
 * 
 * Generates realistic mock data for development and testing.
 * Replace with real provider for production use.
 */

import type { MarketData, MarkPrice } from '@/types';
import type {
  ITradeSource,
  IMarketSource,
  IPriceSource,
  IDataProvider,
  RawTrade,
} from './types';

// Mock market data
const MOCK_MARKETS: MarketData[] = [
  {
    conditionId: '0xabc123def456789',
    title: 'Will Bitcoin reach $100k by end of 2025?',
    description: 'This market resolves YES if Bitcoin price exceeds $100,000 USD.',
    status: 'OPEN',
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-12-31'),
  },
  {
    conditionId: '0xdef456789abc123',
    title: 'US Presidential Election 2024 Winner',
    description: 'This market resolves based on the winner of the 2024 US Presidential Election.',
    status: 'RESOLVED',
    outcomes: [{ name: 'Democrat', index: 0 }, { name: 'Republican', index: 1 }],
    endTime: new Date('2024-11-05'),
    resolutionPrice: { 0: 0, 1: 1 },
  },
  {
    conditionId: '0x789abc123def456',
    title: 'ETH/BTC ratio above 0.05 by March 2025?',
    description: 'Resolves YES if ETH/BTC trading pair exceeds 0.05 ratio.',
    status: 'OPEN',
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-03-31'),
  },
  {
    conditionId: '0x456789abc123def',
    title: 'Fed rate cut in Q1 2025?',
    description: 'Resolves YES if Federal Reserve cuts interest rates in Q1 2025.',
    status: 'OPEN',
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-03-31'),
  },
  {
    conditionId: '0x123456789abcdef',
    title: 'Apple stock above $200 by Q2 2025?',
    description: 'Resolves YES if AAPL closes above $200 by end of Q2 2025.',
    status: 'OPEN',
    outcomes: [{ name: 'Yes', index: 0 }, { name: 'No', index: 1 }],
    endTime: new Date('2025-06-30'),
  },
];

// Current mock prices (simulating live market)
const MOCK_PRICES: Record<string, Record<number, number>> = {
  '0xabc123def456789': { 0: 0.65, 1: 0.35 },
  '0x789abc123def456': { 0: 0.42, 1: 0.58 },
  '0x456789abc123def': { 0: 0.73, 1: 0.27 },
  '0x123456789abcdef': { 0: 0.55, 1: 0.45 },
};

// Seeded random for reproducible mock data
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/**
 * Generate mock trades for a wallet
 */
function generateMockTrades(
  walletAddress: string,
  from: Date,
  to: Date
): RawTrade[] {
  // Use wallet address as seed for reproducible data
  const seed = walletAddress.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const random = seededRandom(seed);
  
  const trades: RawTrade[] = [];
  const markets = MOCK_MARKETS.filter(m => m.status !== 'RESOLVED');
  
  // Generate 10-30 trades per wallet
  const numTrades = Math.floor(random() * 20) + 10;
  const timeRange = to.getTime() - from.getTime();
  
  for (let i = 0; i < numTrades; i++) {
    const market = markets[Math.floor(random() * markets.length)];
    const tradeTime = new Date(from.getTime() + random() * timeRange);
    
    // Skip if before market exists
    if (tradeTime < from) continue;
    
    const outcome = random() > 0.5 ? 0 : 1;
    const side = random() > 0.4 ? 'BUY' : 'SELL';
    const price = 0.2 + random() * 0.6; // 0.20 - 0.80
    const size = Math.floor(random() * 500) + 50; // 50 - 550 shares
    const fee = size * price * 0.001; // 0.1% fee
    
    trades.push({
      txHash: `0x${(seed + i).toString(16).padStart(64, '0')}`,
      logIndex: i,
      blockTime: tradeTime,
      blockNumber: 50000000 + Math.floor(random() * 1000000),
      conditionId: market.conditionId,
      outcome,
      side,
      price: Math.round(price * 10000) / 10000,
      size,
      fee: Math.round(fee * 100) / 100,
    });
  }
  
  // Sort by time
  return trades.sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
}

/**
 * Mock Trade Source Implementation
 */
export class MockTradeSource implements ITradeSource {
  getName(): string {
    return 'MockTradeSource';
  }

  async fetchTrades(walletAddress: string, from: Date, to: Date): Promise<RawTrade[]> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    
    return generateMockTrades(walletAddress, from, to);
  }
}

/**
 * Mock Market Source Implementation
 */
export class MockMarketSource implements IMarketSource {
  getName(): string {
    return 'MockMarketSource';
  }

  async fetchMarket(conditionId: string): Promise<MarketData | null> {
    await new Promise(resolve => setTimeout(resolve, 50));
    
    return MOCK_MARKETS.find(m => m.conditionId === conditionId) || null;
  }

  async fetchMarkets(conditionIds: string[]): Promise<Map<string, MarketData>> {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const result = new Map<string, MarketData>();
    for (const id of conditionIds) {
      const market = MOCK_MARKETS.find(m => m.conditionId === id);
      if (market) {
        result.set(id, market);
      }
    }
    return result;
  }
}

/**
 * Mock Price Source Implementation
 */
export class MockPriceSource implements IPriceSource {
  getName(): string {
    return 'MockPriceSource';
  }

  async getMarkPrice(conditionId: string, outcome: number): Promise<MarkPrice | null> {
    await new Promise(resolve => setTimeout(resolve, 20));
    
    // Check for resolved market
    const market = MOCK_MARKETS.find(m => m.conditionId === conditionId);
    if (market?.status === 'RESOLVED' && market.resolutionPrice) {
      return {
        conditionId,
        outcome,
        price: market.resolutionPrice[outcome] ?? 0,
        timestamp: new Date(),
      };
    }
    
    const prices = MOCK_PRICES[conditionId];
    if (!prices || prices[outcome] === undefined) {
      return null;
    }
    
    // Add small random variance to simulate live market
    const variance = (Math.random() - 0.5) * 0.02;
    const price = Math.max(0.01, Math.min(0.99, prices[outcome] + variance));
    
    return {
      conditionId,
      outcome,
      price: Math.round(price * 10000) / 10000,
      timestamp: new Date(),
    };
  }

  async getMarketPrices(conditionId: string): Promise<Map<number, MarkPrice>> {
    const result = new Map<number, MarkPrice>();
    
    // Check for resolved market
    const market = MOCK_MARKETS.find(m => m.conditionId === conditionId);
    if (market?.status === 'RESOLVED' && market.resolutionPrice) {
      for (const [outcome, price] of Object.entries(market.resolutionPrice)) {
        result.set(parseInt(outcome), {
          conditionId,
          outcome: parseInt(outcome),
          price: price as number,
          timestamp: new Date(),
        });
      }
      return result;
    }
    
    const prices = MOCK_PRICES[conditionId];
    if (!prices) return result;
    
    for (const [outcome, basePrice] of Object.entries(prices)) {
      const variance = (Math.random() - 0.5) * 0.02;
      const price = Math.max(0.01, Math.min(0.99, basePrice + variance));
      
      result.set(parseInt(outcome), {
        conditionId,
        outcome: parseInt(outcome),
        price: Math.round(price * 10000) / 10000,
        timestamp: new Date(),
      });
    }
    
    return result;
  }
}

/**
 * Create a mock data provider instance
 */
export function createMockProvider(): IDataProvider {
  return {
    trades: new MockTradeSource(),
    markets: new MockMarketSource(),
    prices: new MockPriceSource(),
  };
}

/**
 * Export mock markets for seeding
 */
export { MOCK_MARKETS };
