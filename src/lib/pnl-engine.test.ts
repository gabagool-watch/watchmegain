/**
 * Unit tests for PnL Engine
 * 
 * Test cases from requirements:
 * - buy 10 @ 0.40, buy 10 @ 0.60 → avg 0.50, shares 20
 * - sell 5 @ 0.70 fee 0.01 → realized = (0.70-0.50)*5 - 0.01 = 0.99
 * - sell remaining @ 0.30 → realized loss
 * - resolved market payout 1.0: unrealized → realized
 */

import { describe, it, expect } from 'vitest';
import {
  createEmptyPosition,
  applyBuy,
  applySell,
  applyTrade,
  calculateUnrealizedPnl,
  calculateTotalPnl,
  replayTrades,
  resolvePosition,
  computePositions,
  type PositionState,
} from './pnl-engine';
import type { TradeData } from '@/types';

// Helper to create trade data
function createTrade(overrides: Partial<TradeData> = {}): TradeData {
  return {
    id: 'test-id',
    walletId: 'wallet-1',
    marketId: 'market-1',
    txHash: '0x123',
    logIndex: 0,
    blockTime: new Date('2024-01-01'),
    blockNumber: 1000000,
    outcome: 0,
    side: 'BUY',
    price: 0.5,
    size: 100,
    cost: 50,
    fee: 0,
    ...overrides,
  };
}

describe('PnL Engine', () => {
  describe('createEmptyPosition', () => {
    it('should create empty position with zeros', () => {
      const position = createEmptyPosition();
      expect(position.shares).toBe(0);
      expect(position.avgEntryPrice).toBe(0);
      expect(position.realizedPnl).toBe(0);
      expect(position.totalCost).toBe(0);
      expect(position.totalFees).toBe(0);
    });
  });

  describe('applyBuy', () => {
    it('should add shares and calculate avg price on first buy', () => {
      const position = createEmptyPosition();
      const result = applyBuy(position, 0.40, 10, 0);
      
      expect(result.shares).toBe(10);
      expect(result.avgEntryPrice).toBe(0.40);
      expect(result.realizedPnl).toBe(0);
      expect(result.totalCost).toBe(4); // 10 * 0.40
    });

    it('should calculate weighted average on multiple buys', () => {
      // buy 10 @ 0.40
      let position = applyBuy(createEmptyPosition(), 0.40, 10, 0);
      // buy 10 @ 0.60
      position = applyBuy(position, 0.60, 10, 0);
      
      expect(position.shares).toBe(20);
      expect(position.avgEntryPrice).toBe(0.50); // (10*0.40 + 10*0.60) / 20
      expect(position.totalCost).toBe(10); // 4 + 6
    });

    it('should include fees in total cost', () => {
      const position = applyBuy(createEmptyPosition(), 0.50, 100, 0.5);
      
      expect(position.shares).toBe(100);
      expect(position.totalCost).toBe(50.5); // 100 * 0.50 + 0.5 fee
      expect(position.totalFees).toBe(0.5);
    });
  });

  describe('applySell', () => {
    it('should calculate realized PnL on sell', () => {
      // Start with position: 20 shares @ 0.50 avg
      const position: PositionState = {
        shares: 20,
        avgEntryPrice: 0.50,
        realizedPnl: 0,
        totalCost: 10,
        totalFees: 0,
      };
      
      // sell 5 @ 0.70 fee 0.01
      const result = applySell(position, 0.70, 5, 0.01);
      
      expect(result.shares).toBe(15);
      expect(result.avgEntryPrice).toBe(0.50); // avg unchanged
      expect(result.realizedPnl).toBeCloseTo(0.99); // (0.70-0.50)*5 - 0.01
      expect(result.totalFees).toBe(0.01);
    });

    it('should calculate loss on sell below avg', () => {
      const position: PositionState = {
        shares: 15,
        avgEntryPrice: 0.50,
        realizedPnl: 0.99,
        totalCost: 10,
        totalFees: 0.01,
      };
      
      // sell remaining 15 @ 0.30
      const result = applySell(position, 0.30, 15, 0);
      
      expect(result.shares).toBe(0);
      expect(result.avgEntryPrice).toBe(0); // reset when no shares
      // Previous realized: 0.99, new: (0.30-0.50)*15 = -3.00
      expect(result.realizedPnl).toBeCloseTo(0.99 - 3.00);
    });

    it('should not allow selling more than available shares', () => {
      const position: PositionState = {
        shares: 10,
        avgEntryPrice: 0.50,
        realizedPnl: 0,
        totalCost: 5,
        totalFees: 0,
      };
      
      // Try to sell 20 (more than available)
      const result = applySell(position, 0.60, 20, 0);
      
      expect(result.shares).toBe(0); // Only sold 10
      expect(result.realizedPnl).toBeCloseTo(1.0); // (0.60-0.50)*10
    });
  });

  describe('Full trade sequence from requirements', () => {
    it('should correctly process: buy 10 @ 0.40, buy 10 @ 0.60, sell 5 @ 0.70 fee 0.01, sell 15 @ 0.30', () => {
      let position = createEmptyPosition();
      
      // buy 10 @ 0.40
      position = applyBuy(position, 0.40, 10, 0);
      expect(position.shares).toBe(10);
      expect(position.avgEntryPrice).toBe(0.40);
      
      // buy 10 @ 0.60
      position = applyBuy(position, 0.60, 10, 0);
      expect(position.shares).toBe(20);
      expect(position.avgEntryPrice).toBe(0.50);
      
      // sell 5 @ 0.70 fee 0.01
      position = applySell(position, 0.70, 5, 0.01);
      expect(position.shares).toBe(15);
      expect(position.avgEntryPrice).toBe(0.50);
      expect(position.realizedPnl).toBeCloseTo(0.99); // (0.70-0.50)*5 - 0.01
      
      // sell remaining 15 @ 0.30
      position = applySell(position, 0.30, 15, 0);
      expect(position.shares).toBe(0);
      expect(position.avgEntryPrice).toBe(0);
      // Total realized: 0.99 + (0.30-0.50)*15 = 0.99 - 3.00 = -2.01
      expect(position.realizedPnl).toBeCloseTo(-2.01);
    });
  });

  describe('calculateUnrealizedPnl', () => {
    it('should calculate unrealized PnL correctly', () => {
      const position: PositionState = {
        shares: 100,
        avgEntryPrice: 0.50,
        realizedPnl: 0,
        totalCost: 50,
        totalFees: 0,
      };
      
      // Mark price higher than entry
      expect(calculateUnrealizedPnl(position, 0.60)).toBe(10); // (0.60-0.50)*100
      
      // Mark price lower than entry
      expect(calculateUnrealizedPnl(position, 0.40)).toBe(-10); // (0.40-0.50)*100
      
      // Mark price equal to entry
      expect(calculateUnrealizedPnl(position, 0.50)).toBe(0);
    });

    it('should return 0 for empty position', () => {
      const position = createEmptyPosition();
      expect(calculateUnrealizedPnl(position, 0.60)).toBe(0);
    });
  });

  describe('calculateTotalPnl', () => {
    it('should sum realized and unrealized', () => {
      const position: PositionState = {
        shares: 50,
        avgEntryPrice: 0.50,
        realizedPnl: 10,
        totalCost: 25,
        totalFees: 0,
      };
      
      // Unrealized: (0.70-0.50)*50 = 10
      // Total: 10 + 10 = 20
      expect(calculateTotalPnl(position, 0.70)).toBe(20);
    });
  });

  describe('resolvePosition', () => {
    it('should convert all unrealized to realized on winning outcome', () => {
      const position: PositionState = {
        shares: 100,
        avgEntryPrice: 0.60,
        realizedPnl: 5,
        totalCost: 60,
        totalFees: 0,
      };
      
      // Winning outcome: payout = 1.0
      const resolved = resolvePosition(position, 1.0);
      
      expect(resolved.shares).toBe(0);
      expect(resolved.avgEntryPrice).toBe(0);
      // Previous realized: 5, settlement: (1.0-0.60)*100 = 40
      expect(resolved.realizedPnl).toBe(45);
    });

    it('should convert all unrealized to realized on losing outcome', () => {
      const position: PositionState = {
        shares: 100,
        avgEntryPrice: 0.60,
        realizedPnl: 5,
        totalCost: 60,
        totalFees: 0,
      };
      
      // Losing outcome: payout = 0.0
      const resolved = resolvePosition(position, 0.0);
      
      expect(resolved.shares).toBe(0);
      // Previous realized: 5, settlement: (0.0-0.60)*100 = -60
      expect(resolved.realizedPnl).toBe(-55);
    });
  });

  describe('replayTrades', () => {
    it('should replay trades in order', () => {
      const trades: TradeData[] = [
        createTrade({ side: 'BUY', price: 0.40, size: 10, cost: 4, blockTime: new Date('2024-01-01') }),
        createTrade({ side: 'BUY', price: 0.60, size: 10, cost: 6, blockTime: new Date('2024-01-02') }),
        createTrade({ side: 'SELL', price: 0.70, size: 5, cost: 3.5, fee: 0.01, blockTime: new Date('2024-01-03') }),
      ];
      
      const position = replayTrades(trades);
      
      expect(position.shares).toBe(15);
      expect(position.avgEntryPrice).toBe(0.50);
      expect(position.realizedPnl).toBeCloseTo(0.99);
    });
  });

  describe('computePositions', () => {
    it('should group by wallet+market+outcome', () => {
      const trades: TradeData[] = [
        createTrade({ walletId: 'w1', marketId: 'm1', outcome: 0, side: 'BUY', price: 0.50, size: 100 }),
        createTrade({ walletId: 'w1', marketId: 'm1', outcome: 1, side: 'BUY', price: 0.50, size: 50 }),
        createTrade({ walletId: 'w2', marketId: 'm1', outcome: 0, side: 'BUY', price: 0.60, size: 200 }),
      ];
      
      const positions = computePositions(trades);
      
      expect(positions.size).toBe(3);
      
      const w1m1o0 = positions.get('w1:m1:0');
      expect(w1m1o0?.shares).toBe(100);
      expect(w1m1o0?.avgEntryPrice).toBe(0.50);
      
      const w1m1o1 = positions.get('w1:m1:1');
      expect(w1m1o1?.shares).toBe(50);
      
      const w2m1o0 = positions.get('w2:m1:0');
      expect(w2m1o0?.shares).toBe(200);
      expect(w2m1o0?.avgEntryPrice).toBe(0.60);
    });
  });

  describe('applyTrade', () => {
    it('should delegate to applyBuy for BUY side', () => {
      const position = createEmptyPosition();
      const trade = createTrade({ side: 'BUY', price: 0.50, size: 100, fee: 0.5 });
      
      const result = applyTrade(position, trade);
      
      expect(result.shares).toBe(100);
      expect(result.avgEntryPrice).toBe(0.50);
    });

    it('should delegate to applySell for SELL side', () => {
      const position: PositionState = {
        shares: 100,
        avgEntryPrice: 0.50,
        realizedPnl: 0,
        totalCost: 50,
        totalFees: 0,
      };
      const trade = createTrade({ side: 'SELL', price: 0.60, size: 50, fee: 0.1 });
      
      const result = applyTrade(position, trade);
      
      expect(result.shares).toBe(50);
      expect(result.realizedPnl).toBeCloseTo(4.9); // (0.60-0.50)*50 - 0.1
    });
  });

  describe('Edge cases', () => {
    it('should handle zero-size position', () => {
      const position = createEmptyPosition();
      expect(calculateUnrealizedPnl(position, 0.50)).toBe(0);
      expect(calculateTotalPnl(position, 0.50)).toBe(0);
    });

    it('should handle very small numbers', () => {
      let position = applyBuy(createEmptyPosition(), 0.0001, 1000000, 0);
      expect(position.shares).toBe(1000000);
      expect(position.avgEntryPrice).toBe(0.0001);
      expect(position.totalCost).toBe(100);
    });

    it('should handle exactly 0 and 1 prices (binary outcome)', () => {
      // Buy at 0.50, resolve at 1.0 (win)
      let position = applyBuy(createEmptyPosition(), 0.50, 100, 0);
      const resolved = resolvePosition(position, 1.0);
      expect(resolved.realizedPnl).toBe(50); // (1.0-0.50)*100

      // Buy at 0.50, resolve at 0.0 (loss)
      position = applyBuy(createEmptyPosition(), 0.50, 100, 0);
      const lost = resolvePosition(position, 0.0);
      expect(lost.realizedPnl).toBe(-50); // (0.0-0.50)*100
    });
  });

  describe('Polymarket-style trade sequences', () => {
    it('should handle parsed subgraph trade values (1e6 scaled)', () => {
      // Simulate subgraph response parsing
      const parseSubgraphValue = (val: string) => parseFloat(val) / 1e6;
      
      // Raw subgraph values
      const rawSize = '100000000'; // 100 shares
      const rawPrice = '500000';   // 0.50
      const rawFee = '50000';      // 0.05

      const size = parseSubgraphValue(rawSize);
      const price = parseSubgraphValue(rawPrice);
      const fee = parseSubgraphValue(rawFee);

      expect(size).toBe(100);
      expect(price).toBe(0.5);
      expect(fee).toBe(0.05);

      // Apply to position
      let position = applyBuy(createEmptyPosition(), price, size, fee);
      expect(position.shares).toBe(100);
      expect(position.avgEntryPrice).toBe(0.5);
      expect(position.totalFees).toBe(0.05);
    });

    it('should calculate correct PnL with fees from subgraph', () => {
      // Complex scenario from Polymarket trades:
      // 1. Buy 100 @ 0.40, fee 0.04 USDC
      // 2. Buy 50 @ 0.60, fee 0.03 USDC  
      // 3. Sell 30 @ 0.55, fee 0.02 USDC
      // 4. Market resolves YES

      let position = createEmptyPosition();

      // Buy 100 @ 0.40
      position = applyBuy(position, 0.40, 100, 0.04);
      expect(position.shares).toBe(100);
      expect(position.avgEntryPrice).toBe(0.40);
      expect(position.totalCost).toBe(40.04); // 100*0.40 + 0.04

      // Buy 50 @ 0.60
      position = applyBuy(position, 0.60, 50, 0.03);
      expect(position.shares).toBe(150);
      expect(position.avgEntryPrice).toBeCloseTo(0.4667, 3);
      expect(position.totalCost).toBeCloseTo(70.07, 2);

      // Sell 30 @ 0.55
      position = applySell(position, 0.55, 30, 0.02);
      expect(position.shares).toBe(120);
      // Realized: (0.55 - 0.4667) * 30 - 0.02 ≈ 2.48
      expect(position.realizedPnl).toBeCloseTo(2.48, 1);

      // Mark-to-market at 0.70 before resolution
      const unrealized = calculateUnrealizedPnl(position, 0.70);
      // (0.70 - 0.4667) * 120 ≈ 28
      expect(unrealized).toBeCloseTo(28, 0);

      // Market resolves YES (payout = 1.0)
      const resolved = resolvePosition(position, 1.0);
      expect(resolved.shares).toBe(0);
      // Final: 2.48 + (1.0 - 0.4667) * 120 ≈ 66.5
      expect(resolved.realizedPnl).toBeCloseTo(66.5, 0);
    });

    it('should handle NO outcome (inverse bet)', () => {
      // Buy NO at 0.30 (implies YES is at 0.70)
      // If market resolves NO, payout is 1.0 for NO holders
      let position = applyBuy(createEmptyPosition(), 0.30, 100, 0);
      
      // Market resolves NO (NO payout = 1.0)
      const resolved = resolvePosition(position, 1.0);
      expect(resolved.realizedPnl).toBe(70); // (1.0 - 0.30) * 100

      // If YES wins instead (NO payout = 0.0)
      position = applyBuy(createEmptyPosition(), 0.30, 100, 0);
      const lost = resolvePosition(position, 0.0);
      expect(lost.realizedPnl).toBe(-30); // (0.0 - 0.30) * 100
    });

    it('should handle multiple outcomes (multi-choice market)', () => {
      // Simulate 3-outcome market: A, B, C
      // Buy A @ 0.33, B @ 0.25
      
      const positionA = applyBuy(createEmptyPosition(), 0.33, 100, 0);
      const positionB = applyBuy(createEmptyPosition(), 0.25, 100, 0);

      // A wins (payout: A=1, B=0, C=0)
      const resolvedA = resolvePosition(positionA, 1.0);
      const resolvedB = resolvePosition(positionB, 0.0);

      expect(resolvedA.realizedPnl).toBe(67); // (1.0 - 0.33) * 100
      expect(resolvedB.realizedPnl).toBe(-25); // (0.0 - 0.25) * 100

      // Net: 67 - 25 = 42 profit
      expect(resolvedA.realizedPnl + resolvedB.realizedPnl).toBe(42);
    });
  });
});
