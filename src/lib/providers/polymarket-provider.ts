/**
 * Polymarket Data Provider
 * 
 * Fetches real data from:
 * - CLOB API (trades/fills history + current prices)
 * - Gamma Markets API (market metadata)
 */

import type { MarketData, MarkPrice } from '@/types';
import type {
  ITradeSource,
  IMarketSource,
  IPriceSource,
  IPositionSource,
  IDataProvider,
  RawTrade,
  RawPosition,
} from './types';

import * as crypto from 'crypto';

// Environment configuration
const GAMMA_MARKETS_API = process.env.GAMMA_MARKETS_API || 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB_API = process.env.POLYMARKET_CLOB_API || 'https://clob.polymarket.com';
const POLYMARKET_DATA_API = process.env.POLYMARKET_DATA_API || 'https://data-api.polymarket.com';
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || '';
const API_RATE_LIMIT_MS = parseInt(process.env.API_RATE_LIMIT_MS || '200', 10);

// Polymarket API Credentials (for authenticated endpoints)
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY || '';
const POLYMARKET_API_SECRET = process.env.POLYMARKET_API_SECRET || '';
const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE || '';
const POLYMARKET_ADDRESS = process.env.POLYMARKET_ADDRESS || '';

// Check if we have authenticated access
const HAS_CLOB_AUTH = !!(POLYMARKET_API_KEY && POLYMARKET_API_SECRET && POLYMARKET_PASSPHRASE);

// Polymarket CTF Exchange contract on Polygon
const POLYMARKET_CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// Rate limiting helper
async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  await new Promise(resolve => setTimeout(resolve, API_RATE_LIMIT_MS));
  return fetch(url, options);
}

/**
 * Create HMAC signature for CLOB API authentication
 */
function createClobSignature(
  timestamp: string,
  method: string,
  path: string,
  body: string = ''
): string {
  const message = timestamp + method.toUpperCase() + path + body;
  return crypto
    .createHmac('sha256', Buffer.from(POLYMARKET_API_SECRET, 'base64'))
    .update(message)
    .digest('base64');
}

/**
 * Fetch with CLOB API authentication
 */
async function authenticatedClobFetch(
  endpoint: string,
  method: string = 'GET',
  body?: object
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = endpoint.replace(POLYMARKET_CLOB_API, '');
  const bodyStr = body ? JSON.stringify(body) : '';
  const signature = createClobSignature(timestamp, method, path, bodyStr);

  const headers: Record<string, string> = {
    'POLY_API_KEY': POLYMARKET_API_KEY,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_PASSPHRASE': POLYMARKET_PASSPHRASE,
    'Content-Type': 'application/json',
  };

  await new Promise(resolve => setTimeout(resolve, API_RATE_LIMIT_MS));
  
  return fetch(endpoint, {
    method,
    headers,
    body: bodyStr || undefined,
  });
}

// =============================================================================
// API Types
// =============================================================================

interface GammaMarket {
  id?: string;
  condition_id?: string;
  question_id?: string;
  question?: string;
  description?: string;
  market_slug?: string;
  end_date_iso?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  minimum_order_size?: string;
  minimum_tick_size?: string;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
  rewards?: {
    rates: Array<{
      asset_address: string;
      rewards_daily_rate: number;
    }>;
  };
}

interface ClobPrice {
  token_id: string;
  price: string;
}

// =============================================================================
// Trade Source Implementation (using CLOB API)
// =============================================================================

export class PolymarketTradeSource implements ITradeSource {
  private tokenToOutcomeCache = new Map<string, { conditionId: string; outcome: number }>();
  private hasLoggedParsedItem = false;

  getName(): string {
    return 'PolymarketCLOB';
  }

  async fetchTrades(walletAddress: string, from: Date, to: Date): Promise<RawTrade[]> {
    const allTrades: RawTrade[] = [];
    const address = walletAddress.toLowerCase();
    this.hasLoggedParsedItem = false; // Reset for each fetch
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FETCHING ALL TRADES (including closed/resolved)`);
    console.log(`Wallet: ${address}`);
    console.log(`Date range: ${from.toISOString()} to ${to.toISOString()}`);
    console.log(`Auth: ${HAS_CLOB_AUTH ? '✅ CLOB API credentials available' : '❌ No CLOB auth'}`);
    console.log(`${'='.repeat(60)}\n`);

    // ============================================================
    // STRATEGY 1: Use authenticated CLOB API if we have credentials
    // This gives us the best data directly from Polymarket
    // ============================================================
    
    if (HAS_CLOB_AUTH) {
      console.log('\n🔐 Using authenticated CLOB API...');
      const clobTrades = await this.fetchFromAuthenticatedClob(address, from, to);
      
      if (clobTrades.length > 0) {
        console.log(`✅ Found ${clobTrades.length} trades from authenticated CLOB API`);
        for (const trade of clobTrades) {
          allTrades.push(trade);
        }
      }
    }

    // ============================================================
    // STRATEGY 2: Use Polymarket Data API with offset pagination
    // ============================================================
    
    console.log('\n🔍 Using Polymarket Data API...');
    
    const endpoints = [
      `${POLYMARKET_DATA_API}/trades?user=${address}`,
      `${POLYMARKET_DATA_API}/activity?user=${address}`,
    ];

    for (const baseUrl of endpoints) {
      console.log(`\n📡 Trying endpoint: ${baseUrl.split('?')[0]}`);
      const endpointTrades = await this.fetchFromEndpoint(baseUrl, address, from, to);
      
      if (endpointTrades.length > 0) {
        console.log(`✅ Found ${endpointTrades.length} trades from this endpoint`);
        for (const trade of endpointTrades) {
          const exists = allTrades.some(t => 
            t.txHash === trade.txHash && t.logIndex === trade.logIndex
          );
          if (!exists) {
            allTrades.push(trade);
          }
        }
      }
    }

    // ============================================================
    // STRATEGY 3: Blockchain data via Polygonscan for complete history
    // ============================================================
    
    if (POLYGONSCAN_API_KEY) {
      console.log('\n🔗 Fetching complete history from blockchain (Etherscan V2)...');
      const blockchainTrades = await this.fetchFromPolygonscan(address, from, to);
      
      // Merge blockchain trades, avoiding duplicates
      let newFromBlockchain = 0;
      for (const trade of blockchainTrades) {
        const exists = allTrades.some(t => 
          t.txHash === trade.txHash && t.conditionId === trade.conditionId
        );
        if (!exists) {
          allTrades.push(trade);
          newFromBlockchain++;
        }
      }
      console.log(`  ✅ Added ${newFromBlockchain} new trades from blockchain`);
    }

    // Final summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 TOTAL UNIQUE TRADES FOUND: ${allTrades.length}`);
    if (allTrades.length === 0) {
      console.log(`\n⚠️  No trades found for ${address}`);
      if (!POLYGONSCAN_API_KEY) {
        console.log('💡 Tip: Add POLYGONSCAN_API_KEY to .env for blockchain fallback');
        console.log('   Get a free key at: https://polygonscan.com/apis');
      }
    }
    console.log(`${'='.repeat(60)}\n`);
    
    return allTrades;
  }

  /**
   * Fetch trades using authenticated CLOB API
   * This gives us the best data directly from Polymarket
   */
  private async fetchFromAuthenticatedClob(
    address: string,
    from: Date,
    to: Date
  ): Promise<RawTrade[]> {
    const trades: RawTrade[] = [];
    
    if (!HAS_CLOB_AUTH) {
      console.log('  ⚠️ No CLOB API credentials, skipping authenticated fetch');
      return trades;
    }

    try {
      // Fetch user's trade history from CLOB API
      // The trades endpoint returns all fills for the authenticated user
      const tradesUrl = `${POLYMARKET_CLOB_API}/trades`;
      console.log(`  Fetching from authenticated endpoint: ${tradesUrl}`);
      
      const response = await authenticatedClobFetch(tradesUrl, 'GET');
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`  ⚠️ CLOB API returned ${response.status}: ${errorText.slice(0, 200)}`);
        return trades;
      }

      const data = await response.json();
      const items = Array.isArray(data) ? data : (data.trades || data.data || []);
      
      console.log(`  Got ${items.length} trades from CLOB API`);
      
      // Log sample if we have data
      if (items.length > 0) {
        console.log(`  Sample trade keys: ${Object.keys(items[0]).join(', ')}`);
      }

      for (const item of items) {
        const parsed = await this.parseTradeItem(item as Record<string, unknown>);
        if (parsed) {
          // Check date range
          if (parsed.blockTime >= from && parsed.blockTime <= to) {
            trades.push(parsed);
          }
        }
      }

      console.log(`  ✅ Parsed ${trades.length} trades from authenticated CLOB API`);

    } catch (error) {
      console.error('  ❌ Failed to fetch from authenticated CLOB:', error);
    }

    return trades;
  }

  /**
   * Fetch trades from a specific endpoint with offset pagination
   * IMPORTANT: The Polymarket API has a bug where it cycles/repeats data after ~1500 items
   * We detect this by tracking unique transaction hashes and stop when no new trades appear
   */
  private async fetchFromEndpoint(
    baseUrl: string, 
    address: string, 
    from: Date, 
    to: Date
  ): Promise<RawTrade[]> {
    const trades: RawTrade[] = [];
    const seenTxHashes = new Set<string>(); // Track unique trades
    const limit = 500;
    let offset = 0;
    let hasMore = true;
    let pageNumber = 0;
    const MAX_PAGES = 20; // Reduced - API cycles after ~1500 items anyway
    let consecutiveDuplicatePages = 0;
    
    while (hasMore && pageNumber < MAX_PAGES) {
      pageNumber++;
      
      // Build URL with pagination
      let url = baseUrl;
      const separator = baseUrl.includes('?') ? '&' : '?';
      url += `${separator}limit=${limit}&offset=${offset}`;
      
      try {
        console.log(`  [Page ${pageNumber}] Fetching offset ${offset}...`);
        
        const response = await rateLimitedFetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          }
        });
        
        if (!response.ok) {
          console.log(`  ❌ API returned ${response.status}`);
          break;
        }

        const data = await response.json();
        
        // Handle response format
        let items: unknown[] = [];
        
        if (Array.isArray(data)) {
          items = data;
        } else if (typeof data === 'object' && data !== null) {
          items = data.data || data.trades || data.activity || data.history || data.items || [];
        }
        
        if (items.length === 0) {
          console.log(`  ✓ Page ${pageNumber}: No more items, pagination complete`);
          hasMore = false;
          break;
        }

        // Log sample on first page
        if (pageNumber === 1 && items.length > 0) {
          console.log(`  📦 Sample item keys: ${Object.keys(items[0] as object).join(', ')}`);
        }

        // Parse and deduplicate items
        let newTradesThisPage = 0;
        for (const item of items) {
          const parsed = await this.parseTradeItem(item as Record<string, unknown>);
          if (parsed) {
            // Create unique key from txHash + logIndex
            const uniqueKey = `${parsed.txHash}-${parsed.logIndex}`;
            if (!seenTxHashes.has(uniqueKey)) {
              seenTxHashes.add(uniqueKey);
              trades.push(parsed);
              newTradesThisPage++;
            }
          }
        }
        
        console.log(`  [Page ${pageNumber}] Fetched ${items.length}, new unique: ${newTradesThisPage}, total unique: ${trades.length}`);

        // Detect API cycling/repeating data
        if (newTradesThisPage === 0) {
          consecutiveDuplicatePages++;
          if (consecutiveDuplicatePages >= 2) {
            console.log(`  ✓ API is cycling data (${consecutiveDuplicatePages} pages of duplicates), stopping`);
            hasMore = false;
            break;
          }
        } else {
          consecutiveDuplicatePages = 0;
        }

        // Move to next page
        offset += items.length;

        // If we got fewer items than the limit, we've reached the end
        if (items.length < limit) {
          console.log(`  ✓ Received ${items.length} < ${limit}, pagination complete`);
          hasMore = false;
        }
      } catch (error) {
        console.log(`  ❌ Error on page ${pageNumber}: ${error instanceof Error ? error.message : 'Unknown'}`);
        hasMore = false;
      }
    }

    if (pageNumber >= MAX_PAGES) {
      console.log(`  ⚠️ Reached max pages limit (${MAX_PAGES})`);
    }
    
    console.log(`  📊 Final: ${trades.length} unique trades from ${pageNumber} pages`);

    return trades;
  }

  /**
   * Fallback: fetch trades using offset-based pagination
   */
  private async fetchTradesWithOffset(
    address: string, 
    from: Date, 
    to: Date, 
    alreadyFetched: number
  ): Promise<RawTrade[]> {
    const trades: RawTrade[] = [];
    let offset = alreadyFetched;
    const limit = 1000;
    const MAX_TRADES = 100000;
    
    console.log(`\n[Offset Pagination] Starting from offset ${offset}`);
    
    while (offset < MAX_TRADES) {
      const url = `${POLYMARKET_DATA_API}/trades?user=${address}&limit=${limit}&offset=${offset}`;
      
      try {
        const response = await rateLimitedFetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PnLTracker/1.0',
          }
        });
        
        if (!response.ok) {
          console.log(`[Offset] API returned ${response.status}, stopping`);
          break;
        }

        const data = await response.json();
        
        let items: unknown[] = [];
        if (Array.isArray(data)) {
          items = data;
        } else if (typeof data === 'object' && data !== null) {
          items = data.data || data.trades || data.activity || data.history || data.items || [];
        }
        
        if (items.length === 0) {
          console.log(`[Offset] No more trades at offset ${offset}`);
          break;
        }

        console.log(`[Offset] Fetched ${items.length} at offset ${offset} (total: ${offset + items.length})`);

        for (const item of items) {
          const parsed = await this.parseTradeItem(item as Record<string, unknown>);
          if (parsed) {
            const tradeTime = parsed.blockTime;
            if (tradeTime >= from && tradeTime <= to) {
              trades.push(parsed);
            }
          }
        }

        if (items.length < limit) {
          console.log(`[Offset] Got ${items.length} < ${limit}, no more data`);
          break;
        }
        
        offset += limit;
      } catch (error) {
        console.error(`[Offset] Failed at offset ${offset}:`, error);
        break;
      }
    }
    
    console.log(`[Offset Pagination] Found ${trades.length} additional trades in date range`);
    return trades;
  }

  /**
   * Fetch ALL historical trades from Etherscan V2 API (blockchain data)
   * This is the most reliable source for complete trade history
   * 
   * Strategy:
   * 1. Fetch ALL ERC1155 transfers (outcome tokens) with block-based pagination
   * 2. Fetch ALL ERC20 USDC transfers  
   * 3. Match them by transaction hash to calculate prices
   */
  private async fetchFromPolygonscan(address: string, from: Date, to: Date): Promise<RawTrade[]> {
    const CHAIN_ID = 137;
    const API_BASE = 'https://api.etherscan.io/v2/api';
    const USDC_CONTRACT = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'; // USDC.e
    const USDC_NATIVE = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'; // Native USDC
    
    console.log('\n🔗 Fetching complete history from blockchain (Etherscan V2)...');
    
    interface TokenTransfer {
      hash: string;
      blockNumber: string;
      timeStamp: string;
      from: string;
      to: string;
      tokenID?: string;
      tokenValue?: string;
      value?: string;
      tokenSymbol?: string;
      contractAddress?: string;
      logIndex?: string;
    }
    
    // Helper to fetch all pages with block-based pagination
    const fetchAllPages = async (action: string): Promise<TokenTransfer[]> => {
      const allResults: TokenTransfer[] = [];
      let page = 1;
      const pageSize = 10000;
      let lastBlockNumber = 0;
      
      while (true) {
        const url = `${API_BASE}?chainid=${CHAIN_ID}&module=account&action=${action}&address=${address}&startblock=${lastBlockNumber}&endblock=99999999&page=${page}&offset=${pageSize}&sort=asc&apikey=${POLYGONSCAN_API_KEY}`;
        
        console.log(`  [${action}] Page ${page} from block ${lastBlockNumber}...`);
        
        const response = await rateLimitedFetch(url);
        const data = await response.json();
        
        if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
          break;
        }
        
        // Filter duplicates
        const newItems = data.result.filter((item: TokenTransfer) => {
          const isDuplicate = allResults.some(existing => 
            existing.hash === item.hash && 
            existing.tokenID === item.tokenID &&
            existing.value === item.value
          );
          return !isDuplicate;
        });
        
        allResults.push(...newItems);
        console.log(`    Got ${data.result.length}, new: ${newItems.length}, total: ${allResults.length}`);
        
        if (data.result.length < pageSize) {
          break;
        }
        
        // Continue from last block to get more data
        const lastItem = data.result[data.result.length - 1];
        const newLastBlock = parseInt(lastItem.blockNumber);
        
        if (newLastBlock === lastBlockNumber) {
          page++;
        } else {
          lastBlockNumber = newLastBlock;
          page = 1;
        }
        
        // Safety limit
        if (allResults.length > 100000) {
          console.log(`    Reached safety limit (100k items)`);
          break;
        }
      }
      
      return allResults;
    };
    
    try {
      // 1. Fetch ALL ERC1155 transfers (Polymarket outcome tokens)
      console.log('  📦 Fetching ERC1155 transfers (outcome tokens)...');
      const erc1155Transfers = await fetchAllPages('token1155tx');
      console.log(`  Total ERC1155 transfers: ${erc1155Transfers.length}`);
      
      // 2. Fetch ALL ERC20 transfers (USDC payments)
      console.log('  💵 Fetching ERC20 transfers (USDC payments)...');
      const erc20Transfers = await fetchAllPages('tokentx');
      
      // Filter for USDC only
      const usdcTransfers = erc20Transfers.filter(tx => 
        tx.contractAddress?.toLowerCase() === USDC_CONTRACT.toLowerCase() ||
        tx.contractAddress?.toLowerCase() === USDC_NATIVE.toLowerCase()
      );
      console.log(`  Total ERC20: ${erc20Transfers.length}, USDC only: ${usdcTransfers.length}`);
      
      // 3. Group by transaction hash
      console.log('  🔗 Matching transfers by transaction hash...');
      
      const txMap = new Map<string, {
        erc1155: TokenTransfer[];
        usdc: TokenTransfer[];
      }>();
      
      for (const tx of erc1155Transfers) {
        if (!txMap.has(tx.hash)) {
          txMap.set(tx.hash, { erc1155: [], usdc: [] });
        }
        txMap.get(tx.hash)!.erc1155.push(tx);
      }
      
      for (const tx of usdcTransfers) {
        if (!txMap.has(tx.hash)) {
          txMap.set(tx.hash, { erc1155: [], usdc: [] });
        }
        txMap.get(tx.hash)!.usdc.push(tx);
      }
      
      console.log(`  Unique transactions: ${txMap.size}`);
      
      // 4. Calculate trades with prices
      const trades: RawTrade[] = [];
      const addressLower = address.toLowerCase();
      
      // Use Array.from to iterate over Map entries for better compatibility
      for (const entry of Array.from(txMap.entries())) {
        const [hash, data] = entry;
        if (data.erc1155.length === 0) continue;
        
        // Calculate total USDC in this transaction
        let usdcIn = 0;
        let usdcOut = 0;
        
        for (const usdc of data.usdc) {
          const amount = parseFloat(usdc.value || '0') / 1e6; // USDC has 6 decimals
          if (usdc.to.toLowerCase() === addressLower) {
            usdcIn += amount;
          } else if (usdc.from.toLowerCase() === addressLower) {
            usdcOut += amount;
          }
        }
        
        // Process each ERC1155 transfer in this tx
        for (const transfer of data.erc1155) {
          const timestamp = new Date(parseInt(transfer.timeStamp) * 1000);
          
          // Filter by date range
          if (timestamp < from || timestamp > to) {
            continue;
          }
          
          const isBuy = transfer.to.toLowerCase() === addressLower;
          const shares = parseFloat(transfer.tokenValue || '0');
          
          // Calculate price by matching USDC amount
          const totalShares = data.erc1155.reduce(
            (sum: number, t: TokenTransfer) => sum + parseFloat(t.tokenValue || '0'), 
            0
          );
          const shareRatio = totalShares > 0 ? shares / totalShares : 1;
          const usdcAmount = isBuy ? usdcOut * shareRatio : usdcIn * shareRatio;
          const pricePerShare = shares > 0 ? usdcAmount / shares : 0;
          
          // tokenID is the outcome token ID - use it directly as conditionId
          // (resolving to market via Gamma API is too slow for thousands of trades)
          const tokenId = transfer.tokenID || '';
          
          trades.push({
            txHash: hash,
            logIndex: parseInt(transfer.logIndex || '0'),
            blockTime: timestamp,
            blockNumber: parseInt(transfer.blockNumber || '0'),
            conditionId: tokenId, // Use tokenID directly - unique per outcome
            outcome: 0, // We can't know outcome without API call, default to 0
            side: isBuy ? 'BUY' : 'SELL',
            price: pricePerShare,
            size: shares,
            fee: 0, // Fees are included in USDC amount
          });
        }
      }
      
      console.log(`  📊 Total blockchain trades with prices: ${trades.length}`);
      console.log(`    Trades with valid price (0-$1): ${trades.filter(t => t.price > 0 && t.price < 1.1).length}`);
      
      return trades;
      
    } catch (error) {
      console.error('  ❌ Failed to fetch from Etherscan:', error);
      return [];
    }
  }

  private async parseTradeItem(item: Record<string, unknown>): Promise<RawTrade | null> {
    try {
      // The Data API returns conditionId directly - use it!
      const conditionId = item.conditionId as string | undefined;
      const outcomeIndex = item.outcomeIndex as number | undefined;
      
      // Try to find token ID from various field names (for resolving market if no conditionId)
      const tokenId = (
        item.asset ||           // Data API uses 'asset'
        item.asset_id || 
        item.token_id || 
        item.assetId || 
        item.tokenId ||
        item.market ||
        item.outcomeToken ||
        item.outcome_token
      ) as string | undefined;
      
      // We need either conditionId or tokenId
      let finalConditionId = conditionId;
      let finalOutcome = outcomeIndex ?? 0;
      
      // If no conditionId, use tokenId directly (skip slow Gamma API lookup)
      if (!finalConditionId && tokenId) {
        finalConditionId = tokenId;
        finalOutcome = 0; // Can't determine outcome without API call
      }
      
      if (!finalConditionId) {
        return null;
      }
      
      // Log first successful parse for debugging
      if (!this.hasLoggedParsedItem) {
        console.log(`Successfully parsing trade: conditionId=${finalConditionId}, outcome=${finalOutcome}, size=${item.size}, price=${item.price}`);
        this.hasLoggedParsedItem = true;
      }

      // Parse size and price from various field names
      const size = parseFloat(String(
        item.size || item.amount || item.shares || item.quantity || '0'
      ));
      const price = parseFloat(String(
        item.price || item.avg_price || item.avgPrice || '0'
      ));
      
      // Parse timestamp from various field names
      const rawTimestamp = (
        item.timestamp || 
        item.created_at || 
        item.createdAt ||
        item.match_time ||
        item.matchTime ||
        item.time ||
        item.date
      ) as string | number | undefined;
      
      // Handle Unix timestamp (seconds) vs milliseconds vs ISO string
      let timestamp: number | string | undefined = rawTimestamp;
      if (typeof rawTimestamp === 'number') {
        // If it looks like seconds (before year 2100 in seconds = 4102444800)
        // then convert to milliseconds
        if (rawTimestamp < 4102444800) {
          timestamp = rawTimestamp * 1000;
        }
      }

      // Parse side - handle various formats including redemptions
      const sideRaw = (item.side || item.type || item.action || item.tradeType || 'BUY') as string;
      const sideUpper = sideRaw.toUpperCase();
      // Treat redemptions/resolutions as SELL since you're receiving payout
      const side = (
        sideUpper.includes('SELL') || 
        sideUpper.includes('REDEEM') || 
        sideUpper.includes('RESOLVE') ||
        sideUpper.includes('PAYOUT')
      ) ? 'SELL' : 'BUY';

      return {
        txHash: (
          item.transactionHash ||    // Data API uses transactionHash
          item.transaction_hash || 
          item.txHash ||
          item.tx_hash ||
          item.id || 
          `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`
        ) as string,
        logIndex: (item.log_index || item.logIndex || 0) as number,
        blockTime: timestamp ? new Date(timestamp) : new Date(),
        blockNumber: (item.block_number || item.blockNumber || 0) as number,
        conditionId: finalConditionId,
        outcome: finalOutcome,
        side: side as 'BUY' | 'SELL',
        price,
        size,
        fee: parseFloat(String(item.fee || item.fees || '0')),
        // Include market metadata from trade data
        marketTitle: item.title as string | undefined,
        marketSlug: item.slug as string | undefined,
      };
    } catch (error) {
      console.error('parseTradeItem error:', error);
      return null;
    }
  }

  private failedTokenLookups = new Set<string>();
  
  private async resolveTokenId(tokenId: string): Promise<{ conditionId: string; outcome: number } | null> {
    // Check cache first
    if (this.tokenToOutcomeCache.has(tokenId)) {
      return this.tokenToOutcomeCache.get(tokenId)!;
    }
    
    // Check negative cache - don't retry failed lookups
    if (this.failedTokenLookups.has(tokenId)) {
      return null;
    }

    try {
      // Fetch from Gamma API to resolve token ID to condition + outcome
      const response = await rateLimitedFetch(`${GAMMA_MARKETS_API}/markets?token_id=${tokenId}`);
      if (!response.ok) {
        this.failedTokenLookups.add(tokenId);
        return null;
      }

      const markets: GammaMarket[] = await response.json();
      if (!markets || markets.length === 0) {
        this.failedTokenLookups.add(tokenId);
        return null;
      }

      const market = markets[0];
      if (!market.tokens || !market.condition_id) {
        this.failedTokenLookups.add(tokenId);
        return null;
      }

      const tokenIndex = market.tokens.findIndex(t => t.token_id === tokenId);
      
      if (tokenIndex === -1) {
        this.failedTokenLookups.add(tokenId);
        return null;
      }

      const result = {
        conditionId: market.condition_id,
        outcome: tokenIndex,
      };

      this.tokenToOutcomeCache.set(tokenId, result);
      return result;
    } catch (error) {
      this.failedTokenLookups.add(tokenId);
      return null;
    }
  }
}

// =============================================================================
// Market Source Implementation
// =============================================================================

export class PolymarketMarketSource implements IMarketSource {
  private cache = new Map<string, { market: MarketData; timestamp: number }>();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  getName(): string {
    return 'GammaMarketsAPI';
  }

  async fetchMarket(conditionId: string): Promise<MarketData | null> {
    // Check cache
    const cached = this.cache.get(conditionId);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.market;
    }

    try {
      const response = await rateLimitedFetch(`${GAMMA_MARKETS_API}/markets?condition_id=${conditionId}`);
      
      if (!response.ok) {
        console.error(`Gamma API error: ${response.status} for condition ${conditionId}`);
        return null;
      }

      const markets: GammaMarket[] = await response.json();
      
      if (!markets || markets.length === 0) {
        console.warn(`No market found for condition ${conditionId}`);
        return null;
      }

      const market = this.parseGammaMarket(markets[0]);
      
      if (!market) {
        return null;
      }
      
      // Cache the result
      this.cache.set(conditionId, { market, timestamp: Date.now() });
      
      return market;
    } catch (error) {
      console.error('Failed to fetch market from Gamma API:', error);
      return null;
    }
  }

  async fetchMarkets(conditionIds: string[]): Promise<Map<string, MarketData>> {
    const result = new Map<string, MarketData>();

    // Fetch in parallel with some concurrency control
    const batchSize = 10;
    for (let i = 0; i < conditionIds.length; i += batchSize) {
      const batch = conditionIds.slice(i, i + batchSize);
      const promises = batch.map(id => this.fetchMarket(id));
      const markets = await Promise.all(promises);
      
      batch.forEach((id, index) => {
        const market = markets[index];
        if (market) {
          result.set(id, market);
        }
      });
    }

    return result;
  }

  private parseGammaMarket(gamma: GammaMarket): MarketData | null {
    // Validate required fields
    if (!gamma.condition_id) {
      console.warn('Market missing condition_id');
      return null;
    }

    const tokens = gamma.tokens || [];
    
    // Determine market status
    let status: 'OPEN' | 'CLOSED' | 'RESOLVED' = 'OPEN';
    if (gamma.closed || gamma.archived) {
      // Check if any outcome has winner = true
      const hasWinner = tokens.length > 0 && tokens.some(t => t.winner);
      status = hasWinner ? 'RESOLVED' : 'CLOSED';
    } else if (!gamma.active || !gamma.accepting_orders) {
      status = 'CLOSED';
    }

    // Build resolution price if resolved
    let resolutionPrice: Record<number, number> | undefined;
    if (status === 'RESOLVED' && tokens.length > 0) {
      resolutionPrice = {};
      tokens.forEach((token, index) => {
        resolutionPrice![index] = token.winner ? 1 : 0;
      });
    }

    return {
      conditionId: gamma.condition_id,
      title: gamma.question || 'Unknown Market',
      description: gamma.description || '',
      status,
      outcomes: tokens.map((token, index) => ({
        name: token.outcome || `Outcome ${index}`,
        index,
        tokenId: token.token_id,
      })),
      endTime: gamma.end_date_iso ? new Date(gamma.end_date_iso) : undefined,
      resolutionPrice,
    };
  }
}

// =============================================================================
// Price Source Implementation
// =============================================================================

export class PolymarketPriceSource implements IPriceSource {
  private marketSource: PolymarketMarketSource;

  constructor(marketSource: PolymarketMarketSource) {
    this.marketSource = marketSource;
  }

  getName(): string {
    return 'PolymarketCLOB';
  }

  async getMarkPrice(conditionId: string, outcome: number): Promise<MarkPrice | null> {
    const market = await this.marketSource.fetchMarket(conditionId);
    if (!market) {
      return null;
    }

    // If market is resolved, return payout price
    if (market.status === 'RESOLVED' && market.resolutionPrice) {
      return {
        conditionId,
        outcome,
        price: market.resolutionPrice[outcome] ?? 0,
        timestamp: new Date(),
      };
    }

    // Get token ID for this outcome
    const outcomeData = market.outcomes[outcome] as { name: string; index: number; tokenId?: string };
    if (!outcomeData?.tokenId) {
      return null;
    }

    try {
      // Fetch current price from CLOB API
      const response = await fetch(`${POLYMARKET_CLOB_API}/prices?token_ids=${outcomeData.tokenId}`);
      
      if (!response.ok) {
        // Fallback: use last trade price from subgraph or cached market price
        return null;
      }

      const prices: ClobPrice[] = await response.json();
      const priceData = prices.find(p => p.token_id === outcomeData.tokenId);
      
      if (!priceData) {
        return null;
      }

      return {
        conditionId,
        outcome,
        price: parseFloat(priceData.price),
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('Failed to fetch price from CLOB:', error);
      return null;
    }
  }

  async getMarketPrices(conditionId: string): Promise<Map<number, MarkPrice>> {
    const result = new Map<number, MarkPrice>();
    const market = await this.marketSource.fetchMarket(conditionId);
    
    if (!market) {
      return result;
    }

    // Fetch prices for all outcomes
    const tokenIds = market.outcomes
      .map(o => (o as { tokenId?: string }).tokenId)
      .filter(Boolean);

    if (tokenIds.length === 0) {
      return result;
    }

    try {
      // If resolved, use payout prices
      if (market.status === 'RESOLVED' && market.resolutionPrice) {
        market.outcomes.forEach((_, index) => {
          result.set(index, {
            conditionId,
            outcome: index,
            price: market.resolutionPrice![index] ?? 0,
            timestamp: new Date(),
          });
        });
        return result;
      }

      // Fetch from CLOB
      const response = await fetch(`${POLYMARKET_CLOB_API}/prices?token_ids=${tokenIds.join(',')}`);
      
      if (response.ok) {
        const prices: ClobPrice[] = await response.json();
        
        market.outcomes.forEach((outcome, index) => {
          const tokenId = (outcome as { tokenId?: string }).tokenId;
          const priceData = prices.find(p => p.token_id === tokenId);
          
          if (priceData) {
            result.set(index, {
              conditionId,
              outcome: index,
              price: parseFloat(priceData.price),
              timestamp: new Date(),
            });
          }
        });
      }
    } catch (error) {
      console.error('Failed to fetch market prices:', error);
    }

    return result;
  }
}

// =============================================================================
// Position Source - Fetches positions with PnL from Data API
// =============================================================================

interface DataApiPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  outcome?: string;
  market?: {
    question?: string;
    slug?: string;
  };
}

export class PolymarketPositionSource implements IPositionSource {
  getName(): string {
    return 'PolymarketDataAPI';
  }

  async fetchPositions(walletAddress: string): Promise<RawPosition[]> {
    const positions: RawPosition[] = [];
    const address = walletAddress.toLowerCase();
    let offset = 0;
    const limit = 500;
    const maxPositions = 50000;

    console.log(`\n📊 Fetching positions from Data API for ${address}...`);

    try {
      while (positions.length < maxPositions) {
        // Only fetch positions with size > 0.01 (active positions)
        // Remove sizeThreshold=0 to exclude closed/empty positions
        const url = `${POLYMARKET_DATA_API}/positions?user=${address}&limit=${limit}&offset=${offset}`;
        console.log(`  Fetching active positions offset=${offset}...`);
        
        const response = await rateLimitedFetch(url);
        
        if (!response.ok) {
          console.log(`  ❌ Data API returned ${response.status}`);
          break;
        }

        const data: DataApiPosition[] = await response.json();
        
        if (!Array.isArray(data) || data.length === 0) {
          console.log(`  No more positions (got ${positions.length} total)`);
          break;
        }

        for (const pos of data) {
          // The outcome from Data API is a string like "Yes", "No", "Up", "Down"
          // We need to map it to an index (0 or 1)
          const outcomeName = pos.outcome || '';
          let outcomeIndex = 0;
          
          // Common outcome mappings
          const outcomeUpper = outcomeName.toUpperCase();
          if (outcomeUpper === 'NO' || outcomeUpper === 'DOWN' || outcomeUpper === '1') {
            outcomeIndex = 1;
          }

          positions.push({
            conditionId: pos.conditionId,
            asset: pos.asset,
            outcome: outcomeIndex,
            outcomeName: outcomeName, // Keep the original string
            size: pos.size,
            avgPrice: pos.avgPrice,
            initialValue: pos.initialValue,
            currentValue: pos.currentValue,
            cashPnl: pos.cashPnl,
            percentPnl: pos.percentPnl || 0,
            marketQuestion: pos.market?.question,
            marketSlug: pos.market?.slug,
          });
        }

        console.log(`  Got ${data.length} positions (total: ${positions.length})`);
        
        if (data.length < limit) {
          break; // No more pages
        }
        
        offset += limit;
      }

      // Calculate totals
      const totalInitialValue = positions.reduce((sum, p) => sum + p.initialValue, 0);
      const totalCurrentValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
      const totalCashPnl = positions.reduce((sum, p) => sum + p.cashPnl, 0);
      const openPositions = positions.filter(p => p.size > 0.001).length;

      console.log(`\n✅ Fetched ${positions.length} positions from Data API`);
      console.log(`   Open positions: ${openPositions}`);
      console.log(`   Total Initial Value: $${totalInitialValue.toFixed(2)}`);
      console.log(`   Total Current Value: $${totalCurrentValue.toFixed(2)}`);
      console.log(`   Total Cash PnL: $${totalCashPnl.toFixed(2)}`);

    } catch (error) {
      console.error('❌ Failed to fetch positions from Data API:', error);
    }

    return positions;
  }
}

// =============================================================================
// Provider Factory
// =============================================================================

export function createPolymarketProvider(): IDataProvider {
  const marketSource = new PolymarketMarketSource();
  
  return {
    trades: new PolymarketTradeSource(),
    markets: marketSource,
    prices: new PolymarketPriceSource(marketSource),
    positions: new PolymarketPositionSource(),
  };
}
