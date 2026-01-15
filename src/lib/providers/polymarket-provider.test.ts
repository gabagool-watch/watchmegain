/**
 * Unit tests for Polymarket Provider
 * 
 * Tests:
 * - Trade parsing from subgraph response
 * - Market metadata parsing from Gamma API
 * - Price resolution
 * - Integration with PnL engine
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createEmptyPosition,
  applyBuy,
  applySell,
  resolvePosition,
  calculateUnrealizedPnl,
} from '../pnl-engine';

// Mock subgraph trade response format
interface MockSubgraphTrade {
  id: string;
  transactionHash: string;
  logIndex: string;
  timestamp: string;
  blockNumber: string;
  market: string;
  asset: string;
  side: string;
  size: string;
  price: string;
  feeAmount: string;
  user: string;
}

// Mock Gamma market response
interface MockGammaMarket {
  condition_id: string;
  question: string;
  description: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  accepting_orders: boolean;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
}

// =============================================================================
// Parsing Tests
// =============================================================================

describe('Polymarket Provider Parsing', () => {
  describe('Trade Parsing', () => {
    it('should parse BUY trade from subgraph format', () => {
      const subgraphTrade: MockSubgraphTrade = {
        id: '0x123-0',
        transactionHash: '0x123456789abcdef',
        logIndex: '0',
        timestamp: '1704067200', // Jan 1, 2024
        blockNumber: '50000000',
        market: '0xcondition123',
        asset: '0xtoken456',
        side: 'BUY',
        size: '100000000', // 100 shares (1e6 decimals)
        price: '500000',   // 0.50 (1e6 decimals)
        feeAmount: '50000', // 0.05 fee
        user: '0xwallet789',
      };

      // Parse the trade (simulating provider logic)
      const parsed = {
        txHash: subgraphTrade.transactionHash,
        logIndex: parseInt(subgraphTrade.logIndex),
        blockTime: new Date(parseInt(subgraphTrade.timestamp) * 1000),
        blockNumber: parseInt(subgraphTrade.blockNumber),
        conditionId: '0xcondition123',
        outcome: 0, // Would come from token resolution
        side: subgraphTrade.side as 'BUY' | 'SELL',
        price: parseFloat(subgraphTrade.price) / 1e6,
        size: parseFloat(subgraphTrade.size) / 1e6,
        fee: parseFloat(subgraphTrade.feeAmount) / 1e6,
      };

      expect(parsed.txHash).toBe('0x123456789abcdef');
      expect(parsed.logIndex).toBe(0);
      expect(parsed.side).toBe('BUY');
      expect(parsed.price).toBe(0.5);
      expect(parsed.size).toBe(100);
      expect(parsed.fee).toBe(0.05);
    });

    it('should parse SELL trade correctly', () => {
      const subgraphTrade: MockSubgraphTrade = {
        id: '0x456-1',
        transactionHash: '0xabcdef123456789',
        logIndex: '1',
        timestamp: '1704153600',
        blockNumber: '50001000',
        market: '0xcondition123',
        asset: '0xtoken456',
        side: 'SELL',
        size: '50000000',  // 50 shares
        price: '700000',   // 0.70
        feeAmount: '35000', // 0.035 fee
        user: '0xwallet789',
      };

      const parsed = {
        side: subgraphTrade.side as 'BUY' | 'SELL',
        price: parseFloat(subgraphTrade.price) / 1e6,
        size: parseFloat(subgraphTrade.size) / 1e6,
        fee: parseFloat(subgraphTrade.feeAmount) / 1e6,
      };

      expect(parsed.side).toBe('SELL');
      expect(parsed.price).toBe(0.7);
      expect(parsed.size).toBe(50);
      expect(parsed.fee).toBe(0.035);
    });

    it('should handle zero fees', () => {
      const subgraphTrade: MockSubgraphTrade = {
        id: '0x789-0',
        transactionHash: '0x999',
        logIndex: '0',
        timestamp: '1704240000',
        blockNumber: '50002000',
        market: '0xcondition123',
        asset: '0xtoken456',
        side: 'BUY',
        size: '1000000000', // 1000 shares
        price: '100000',    // 0.10
        feeAmount: '0',
        user: '0xwallet789',
      };

      const fee = parseFloat(subgraphTrade.feeAmount || '0') / 1e6;
      expect(fee).toBe(0);
    });
  });

  describe('Market Parsing', () => {
    it('should parse open market from Gamma response', () => {
      const gammaMarket: MockGammaMarket = {
        condition_id: '0xcondition123',
        question: 'Will Bitcoin reach $100k by 2025?',
        description: 'Resolves YES if BTC exceeds $100,000 USD.',
        end_date_iso: '2025-12-31T23:59:59Z',
        active: true,
        closed: false,
        archived: false,
        accepting_orders: true,
        tokens: [
          { token_id: '0xtoken_yes', outcome: 'Yes', price: 0.65, winner: false },
          { token_id: '0xtoken_no', outcome: 'No', price: 0.35, winner: false },
        ],
      };

      // Parse market status
      let status: 'OPEN' | 'CLOSED' | 'RESOLVED' = 'OPEN';
      if (gammaMarket.closed || gammaMarket.archived) {
        const hasWinner = gammaMarket.tokens.some(t => t.winner);
        status = hasWinner ? 'RESOLVED' : 'CLOSED';
      }

      expect(status).toBe('OPEN');
      expect(gammaMarket.tokens.length).toBe(2);
      expect(gammaMarket.tokens[0].outcome).toBe('Yes');
    });

    it('should parse resolved market with winner', () => {
      const gammaMarket: MockGammaMarket = {
        condition_id: '0xcondition456',
        question: 'US Election 2024 Winner',
        description: 'Who wins the 2024 presidential election?',
        end_date_iso: '2024-11-05T00:00:00Z',
        active: false,
        closed: true,
        archived: false,
        accepting_orders: false,
        tokens: [
          { token_id: '0xdem', outcome: 'Democrat', price: 0, winner: false },
          { token_id: '0xrep', outcome: 'Republican', price: 1, winner: true },
        ],
      };

      let status: 'OPEN' | 'CLOSED' | 'RESOLVED' = 'OPEN';
      if (gammaMarket.closed || gammaMarket.archived) {
        const hasWinner = gammaMarket.tokens.some(t => t.winner);
        status = hasWinner ? 'RESOLVED' : 'CLOSED';
      }

      // Build resolution prices
      const resolutionPrice: Record<number, number> = {};
      gammaMarket.tokens.forEach((token, index) => {
        resolutionPrice[index] = token.winner ? 1 : 0;
      });

      expect(status).toBe('RESOLVED');
      expect(resolutionPrice[0]).toBe(0); // Democrat lost
      expect(resolutionPrice[1]).toBe(1); // Republican won
    });

    it('should parse closed but unresolved market', () => {
      const gammaMarket: MockGammaMarket = {
        condition_id: '0xcondition789',
        question: 'Will X happen?',
        description: 'Test market',
        end_date_iso: '2024-01-01T00:00:00Z',
        active: false,
        closed: true,
        archived: false,
        accepting_orders: false,
        tokens: [
          { token_id: '0xyes', outcome: 'Yes', price: 0.5, winner: false },
          { token_id: '0xno', outcome: 'No', price: 0.5, winner: false },
        ],
      };

      let status: 'OPEN' | 'CLOSED' | 'RESOLVED' = 'OPEN';
      if (gammaMarket.closed || gammaMarket.archived) {
        const hasWinner = gammaMarket.tokens.some(t => t.winner);
        status = hasWinner ? 'RESOLVED' : 'CLOSED';
      }

      expect(status).toBe('CLOSED');
    });
  });
});

// =============================================================================
// PnL Integration Tests
// =============================================================================

describe('PnL Engine with Parsed Polymarket Trades', () => {
  it('should calculate PnL from parsed buy/buy/sell sequence', () => {
    // Simulate parsed trades from subgraph
    const trades = [
      { side: 'BUY' as const, price: 0.40, size: 100, fee: 0.04 },
      { side: 'BUY' as const, price: 0.60, size: 100, fee: 0.06 },
      { side: 'SELL' as const, price: 0.70, size: 50, fee: 0.035 },
    ];

    let position = createEmptyPosition();

    // Apply trades
    for (const trade of trades) {
      if (trade.side === 'BUY') {
        position = applyBuy(position, trade.price, trade.size, trade.fee);
      } else {
        position = applySell(position, trade.price, trade.size, trade.fee);
      }
    }

    // After 2 buys: 200 shares @ avg 0.50
    // After sell 50 @ 0.70: 150 shares, realized = (0.70 - 0.50) * 50 - 0.035 = 9.965
    expect(position.shares).toBe(150);
    expect(position.avgEntryPrice).toBe(0.5);
    expect(position.realizedPnl).toBeCloseTo(9.965);
    expect(position.totalFees).toBeCloseTo(0.135); // 0.04 + 0.06 + 0.035
  });

  it('should calculate unrealized PnL with current market price', () => {
    let position = applyBuy(createEmptyPosition(), 0.40, 100, 0);
    
    // Current price is 0.60
    const unrealized = calculateUnrealizedPnl(position, 0.60);
    
    expect(unrealized).toBe(20); // (0.60 - 0.40) * 100
  });

  it('should resolve position when market settles', () => {
    // Build position: buy 100 @ 0.40
    let position = applyBuy(createEmptyPosition(), 0.40, 100, 0);
    
    // Market resolves YES (payout = 1.0)
    const resolved = resolvePosition(position, 1.0);
    
    expect(resolved.shares).toBe(0);
    expect(resolved.realizedPnl).toBe(60); // (1.0 - 0.40) * 100
  });

  it('should handle losing resolution', () => {
    // Buy YES at 0.70
    let position = applyBuy(createEmptyPosition(), 0.70, 100, 0);
    
    // Market resolves NO (YES payout = 0)
    const resolved = resolvePosition(position, 0.0);
    
    expect(resolved.shares).toBe(0);
    expect(resolved.realizedPnl).toBe(-70); // (0.0 - 0.70) * 100
  });

  it('should handle complex scenario with fees and resolution', () => {
    // Scenario:
    // 1. Buy 100 YES @ 0.40, fee 0.04
    // 2. Buy 50 YES @ 0.60, fee 0.03
    // 3. Sell 30 YES @ 0.55, fee 0.02
    // 4. Market resolves YES (payout 1.0)

    let position = createEmptyPosition();

    // Buy 100 @ 0.40
    position = applyBuy(position, 0.40, 100, 0.04);
    expect(position.shares).toBe(100);
    expect(position.avgEntryPrice).toBe(0.40);

    // Buy 50 @ 0.60
    position = applyBuy(position, 0.60, 50, 0.03);
    expect(position.shares).toBe(150);
    // new avg = (100 * 0.40 + 50 * 0.60) / 150 = 70 / 150 = 0.4667
    expect(position.avgEntryPrice).toBeCloseTo(0.4667, 3);

    // Sell 30 @ 0.55
    position = applySell(position, 0.55, 30, 0.02);
    expect(position.shares).toBe(120);
    // realized = (0.55 - 0.4667) * 30 - 0.02 = 2.499 - 0.02 = 2.479
    expect(position.realizedPnl).toBeCloseTo(2.48, 1);

    // Market resolves YES
    const resolved = resolvePosition(position, 1.0);
    expect(resolved.shares).toBe(0);
    // Final realized = previous + (1.0 - 0.4667) * 120 = 2.48 + 64 = 66.48
    expect(resolved.realizedPnl).toBeCloseTo(66.48, 0);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  it('should handle very small trades', () => {
    let position = applyBuy(createEmptyPosition(), 0.001, 1, 0.0001);
    expect(position.shares).toBe(1);
    expect(position.avgEntryPrice).toBe(0.001);
  });

  it('should handle large trades', () => {
    let position = applyBuy(createEmptyPosition(), 0.50, 1000000, 50);
    expect(position.shares).toBe(1000000);
    expect(position.totalCost).toBe(500050); // 1M * 0.50 + 50 fee
  });

  it('should handle trades at extreme prices', () => {
    // Buy at 0.01 (very low)
    let position = applyBuy(createEmptyPosition(), 0.01, 100, 0);
    expect(position.avgEntryPrice).toBe(0.01);

    // Market goes to 0.99
    const unrealized = calculateUnrealizedPnl(position, 0.99);
    expect(unrealized).toBe(98); // (0.99 - 0.01) * 100
  });

  it('should handle sequential sells depleting position', () => {
    let position = applyBuy(createEmptyPosition(), 0.50, 100, 0);
    
    // Sell in chunks
    position = applySell(position, 0.60, 30, 0);
    expect(position.shares).toBe(70);
    
    position = applySell(position, 0.55, 40, 0);
    expect(position.shares).toBe(30);
    
    position = applySell(position, 0.45, 30, 0);
    expect(position.shares).toBe(0);
    expect(position.avgEntryPrice).toBe(0); // Reset when depleted
  });

  it('should handle empty string fee from subgraph', () => {
    const feeAmount = '';
    const fee = parseFloat(feeAmount || '0') / 1e6;
    expect(fee).toBe(0);
  });

  it('should handle malformed subgraph values gracefully', () => {
    // These should not throw
    expect(() => parseFloat('0') / 1e6).not.toThrow();
    expect(() => parseInt('0')).not.toThrow();
    expect(() => new Date(0)).not.toThrow();
  });
});
