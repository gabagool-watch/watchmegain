/**
 * Data Provider Interfaces
 * 
 * Abstract interfaces for fetching trade, market, and price data.
 * Allows swapping between mock data (development) and real data sources (production).
 */

import type { TradeData, MarketData, MarkPrice } from '@/types';

/**
 * Raw trade data from external source (before DB mapping)
 */
export interface RawTrade {
  txHash: string;
  logIndex: number;
  blockTime: Date;
  blockNumber: number;
  conditionId: string; // Market identifier
  outcome: number;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  fee: number;
  // Optional market metadata (from Data API)
  marketTitle?: string;
  marketSlug?: string;
}

/**
 * Interface for fetching trade data from external sources
 */
export interface ITradeSource {
  /**
   * Fetch trades for a wallet within a time range
   * @param walletAddress - The wallet address to fetch trades for
   * @param from - Start time (inclusive)
   * @param to - End time (inclusive)
   * @returns Array of raw trade data
   */
  fetchTrades(walletAddress: string, from: Date, to: Date): Promise<RawTrade[]>;

  /**
   * Get the name of this data source
   */
  getName(): string;
}

/**
 * Interface for fetching market metadata
 */
export interface IMarketSource {
  /**
   * Fetch market data by condition ID
   * @param conditionId - The market's condition ID
   * @returns Market metadata or null if not found
   */
  fetchMarket(conditionId: string): Promise<MarketData | null>;

  /**
   * Fetch multiple markets at once
   * @param conditionIds - Array of condition IDs
   * @returns Map of conditionId to MarketData
   */
  fetchMarkets(conditionIds: string[]): Promise<Map<string, MarketData>>;

  /**
   * Get the name of this data source
   */
  getName(): string;
}

/**
 * Interface for fetching current prices (mark-to-market)
 */
export interface IPriceSource {
  /**
   * Get the current mark price for a specific outcome
   * @param conditionId - The market's condition ID
   * @param outcome - The outcome index (0, 1, etc.)
   * @returns Current price or null if unavailable
   */
  getMarkPrice(conditionId: string, outcome: number): Promise<MarkPrice | null>;

  /**
   * Get mark prices for all outcomes in a market
   * @param conditionId - The market's condition ID
   * @returns Map of outcome index to price
   */
  getMarketPrices(conditionId: string): Promise<Map<number, MarkPrice>>;

  /**
   * Get the name of this data source
   */
  getName(): string;
}

/**
 * Raw position data from Data API (with Polymarket's PnL calculations)
 */
export interface RawPosition {
  conditionId: string;
  asset: string;
  outcome: number;
  outcomeName?: string; // "Yes", "No", "Up", "Down", etc.
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  // Optional market metadata
  marketTitle?: string;
  marketSlug?: string;
  marketQuestion?: string;
}

/**
 * Interface for fetching position data directly from Data API
 */
export interface IPositionSource {
  /**
   * Fetch all positions for a wallet (with Polymarket's PnL calculations)
   * @param walletAddress - The wallet address
   * @returns Array of raw position data
   */
  fetchPositions(walletAddress: string): Promise<RawPosition[]>;

  /**
   * Get the name of this data source
   */
  getName(): string;
}

/**
 * Combined data provider interface
 */
export interface IDataProvider {
  trades: ITradeSource;
  markets: IMarketSource;
  prices: IPriceSource;
  positions?: IPositionSource;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  apiKey?: string;
  rpcUrl?: string;
  baseUrl?: string;
  rateLimitMs?: number;
}
