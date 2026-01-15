// Core types used throughout the application

export type TradeSide = 'BUY' | 'SELL';
export type MarketStatus = 'OPEN' | 'CLOSED' | 'RESOLVED';
export type PositionStatus = 'OPEN' | 'CLOSED';

export interface TradeData {
  id?: string;
  walletId: string;
  marketId: string;
  txHash: string;
  logIndex: number;
  blockTime: Date;
  blockNumber: number;
  outcome: number;
  side: TradeSide;
  price: number;
  size: number;
  cost: number;
  fee: number;
}

export interface PositionData {
  walletId: string;
  marketId: string;
  outcome: number;
  shares: number;
  avgEntryPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalCost: number;
  totalFees: number;
  status: PositionStatus;
}

export interface MarketData {
  conditionId: string;
  title: string;
  description?: string;
  status: MarketStatus;
  outcomes: OutcomeData[];
  endTime?: Date;
  resolutionPrice?: Record<number, number>;
}

export interface OutcomeData {
  name: string;
  index: number;
  tokenId?: string; // Polymarket token ID for this outcome
}

export interface WalletStats {
  walletId: string;
  address: string;
  alias?: string;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalPnl: number;
  totalVolume: number;
  totalTrades: number;
  winRate: number;
  openPositions: number;
  closedPositions: number;
}

export interface PnLResult {
  shares: number;
  avgEntryPrice: number;
  realizedPnl: number;
  totalCost: number;
  totalFees: number;
}

export interface MarkPrice {
  conditionId: string;
  outcome: number;
  price: number;
  timestamp: Date;
}

// Filter types
export interface TradeFilter {
  walletId?: string;
  marketId?: string;
  conditionId?: string;
  from?: Date;
  to?: Date;
  side?: TradeSide;
  outcome?: number;
}

export interface PositionFilter {
  walletId?: string;
  marketId?: string;
  status?: PositionStatus;
}

export interface DateRange {
  from: Date;
  to: Date;
}

// API Response types
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SyncStatusResponse {
  jobType: string;
  lastRunAt: Date | null;
  lastSuccess: Date | null;
  lastError: string | null;
  isRunning: boolean;
  itemsProcessed: number;
}
