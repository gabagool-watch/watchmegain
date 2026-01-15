/**
 * PnL Engine - Core calculation logic for position and profit/loss tracking
 * 
 * Uses weighted average cost basis method:
 * - BUY: new_shares = shares + size, new_avg = (shares*avg + size*price) / new_shares
 * - SELL: realized = (price - avg) * size - fee, shares -= size
 */

import type { TradeData, PnLResult, PositionData, TradeSide } from '@/types';

export interface PositionState {
  shares: number;
  avgEntryPrice: number;
  realizedPnl: number;
  totalCost: number;
  totalFees: number;
}

/**
 * Initialize an empty position state
 */
export function createEmptyPosition(): PositionState {
  return {
    shares: 0,
    avgEntryPrice: 0,
    realizedPnl: 0,
    totalCost: 0,
    totalFees: 0,
  };
}

/**
 * Apply a single trade to a position state
 * Returns the new position state after the trade
 */
export function applyTrade(position: PositionState, trade: TradeData): PositionState {
  const { side, price, size, fee } = trade;
  
  if (side === 'BUY') {
    return applyBuy(position, price, size, fee);
  } else {
    return applySell(position, price, size, fee);
  }
}

/**
 * Apply a BUY trade to update position
 * 
 * new_shares = shares + size
 * new_avg = (shares * avg + size * price) / new_shares
 */
export function applyBuy(
  position: PositionState,
  price: number,
  size: number,
  fee: number = 0
): PositionState {
  const { shares, avgEntryPrice, realizedPnl, totalCost, totalFees } = position;
  
  const newShares = shares + size;
  const newAvg = newShares > 0 
    ? (shares * avgEntryPrice + size * price) / newShares 
    : 0;
  
  const tradeCost = size * price + fee;
  
  return {
    shares: newShares,
    avgEntryPrice: newAvg,
    realizedPnl,
    totalCost: totalCost + tradeCost,
    totalFees: totalFees + fee,
  };
}

/**
 * Apply a SELL trade to update position
 * 
 * realized += (price - avg) * size - fee
 * shares -= size
 * avg stays the same (or resets to 0 if shares = 0)
 * 
 * Note: We allow selling more than available shares to handle:
 * - Market resolutions (payout trades)
 * - Out-of-order trade processing
 * - Redemptions
 */
export function applySell(
  position: PositionState,
  price: number,
  size: number,
  fee: number = 0
): PositionState {
  const { shares, avgEntryPrice, realizedPnl, totalCost, totalFees } = position;
  
  // Calculate profit/loss
  // If we have shares, use avg entry price; if not (short/redemption), use the sell price as cost basis
  const effectiveEntryPrice = shares > 0 ? avgEntryPrice : price;
  const profit = (price - effectiveEntryPrice) * size - fee;
  const newShares = shares - size;
  
  return {
    shares: newShares,
    avgEntryPrice: newShares > 0.001 ? avgEntryPrice : 0,
    realizedPnl: realizedPnl + profit,
    totalCost: totalCost, // Cost remains the same
    totalFees: totalFees + fee,
  };
}

/**
 * Calculate unrealized PnL for a position given current mark price
 * 
 * unrealized = (mark_price - avg_entry) * shares
 */
export function calculateUnrealizedPnl(
  position: PositionState,
  markPrice: number
): number {
  if (position.shares <= 0) return 0;
  return (markPrice - position.avgEntryPrice) * position.shares;
}

/**
 * Calculate total PnL (realized + unrealized)
 */
export function calculateTotalPnl(
  position: PositionState,
  markPrice: number
): number {
  return position.realizedPnl + calculateUnrealizedPnl(position, markPrice);
}

/**
 * Replay all trades to compute final position state
 * Trades should be sorted by time (oldest first)
 */
export function replayTrades(trades: TradeData[]): PositionState {
  let position = createEmptyPosition();
  
  for (const trade of trades) {
    position = applyTrade(position, trade);
  }
  
  return position;
}

/**
 * Group trades by wallet + market + outcome and compute positions
 */
export function computePositions(
  trades: TradeData[]
): Map<string, PositionState> {
  const positions = new Map<string, PositionState>();
  
  // Sort trades by time
  const sortedTrades = [...trades].sort(
    (a, b) => a.blockTime.getTime() - b.blockTime.getTime()
  );
  
  for (const trade of sortedTrades) {
    const key = `${trade.walletId}:${trade.marketId}:${trade.outcome}`;
    const position = positions.get(key) || createEmptyPosition();
    positions.set(key, applyTrade(position, trade));
  }
  
  return positions;
}

/**
 * Resolve a position when market is resolved
 * All shares are effectively "sold" at the payout price
 * 
 * For binary markets:
 * - Winning outcome: payout = 1.0
 * - Losing outcome: payout = 0.0
 */
export function resolvePosition(
  position: PositionState,
  payoutPrice: number
): PositionState {
  if (position.shares <= 0) return position;
  
  // All shares settle at payout price
  const settledPnl = (payoutPrice - position.avgEntryPrice) * position.shares;
  
  return {
    shares: 0,
    avgEntryPrice: 0,
    realizedPnl: position.realizedPnl + settledPnl,
    totalCost: position.totalCost,
    totalFees: position.totalFees,
  };
}

/**
 * Calculate win rate from a list of trades
 * A trade is a "win" if the realized profit is positive
 */
export function calculateWinRate(
  trades: TradeData[],
  avgEntryPrices: Map<string, number>
): number {
  const sells = trades.filter((t) => t.side === 'SELL');
  if (sells.length === 0) return 0;
  
  let wins = 0;
  for (const trade of sells) {
    const key = `${trade.walletId}:${trade.marketId}:${trade.outcome}`;
    const avgEntry = avgEntryPrices.get(key) || 0;
    if (trade.price > avgEntry) {
      wins++;
    }
  }
  
  return wins / sells.length;
}

/**
 * Calculate total volume from trades
 */
export function calculateVolume(trades: TradeData[]): number {
  return trades.reduce((sum, t) => sum + t.cost, 0);
}

/**
 * Validate trade data
 */
export function validateTrade(trade: Partial<TradeData>): string[] {
  const errors: string[] = [];
  
  if (!trade.txHash) errors.push('txHash is required');
  if (trade.logIndex === undefined) errors.push('logIndex is required');
  if (!trade.blockTime) errors.push('blockTime is required');
  if (trade.outcome === undefined) errors.push('outcome is required');
  if (!trade.side) errors.push('side is required');
  if (trade.price === undefined || trade.price < 0) errors.push('price must be non-negative');
  if (trade.size === undefined || trade.size <= 0) errors.push('size must be positive');
  if (trade.fee !== undefined && trade.fee < 0) errors.push('fee must be non-negative');
  
  return errors;
}

/**
 * Convert position state to position data for DB storage
 */
export function positionStateToData(
  state: PositionState,
  walletId: string,
  marketId: string,
  outcome: number,
  markPrice: number = 0
): PositionData {
  const unrealizedPnl = calculateUnrealizedPnl(state, markPrice);
  
  return {
    walletId,
    marketId,
    outcome,
    shares: state.shares,
    avgEntryPrice: state.avgEntryPrice,
    realizedPnl: state.realizedPnl,
    unrealizedPnl,
    totalCost: state.totalCost,
    totalFees: state.totalFees,
    status: state.shares > 0 ? 'OPEN' : 'CLOSED',
  };
}
