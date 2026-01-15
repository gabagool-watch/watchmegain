/**
 * Chainlink BTC/USD WebSocket (on-chain)
 *
 * We subscribe to Polygon logs for the Chainlink BTC/USD aggregator and emit price updates.
 *
 * Why: Polymarket resolves BTC Up/Down markets using Chainlink BTC/USD, which can differ from Binance.
 * We need to measure lag/patterns like:
 *  - Binance moves -$6
 *  - Chainlink updates ~1200ms later by -$5..7
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface ChainlinkPriceUpdate {
  feedAddress: string;
  price: number; // float (USD)
  decimals: number;
  roundId: string;
  updatedAtSec: number;
  receivedAt: Date;
  blockNumber?: number;
  txHash?: string;
  logIndex?: number;
}

function strip0x(hex: string) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function word(hexNo0x: string, idx: number) {
  return hexNo0x.slice(idx * 64, (idx + 1) * 64);
}

function hexToBigInt(hexWord: string) {
  return BigInt('0x' + hexWord);
}

function int256FromWord(hexWord: string) {
  const x = hexToBigInt(hexWord);
  const signBit = BigInt(1) << BigInt(255);
  if (x & signBit) {
    // two's complement
    const mod = BigInt(1) << BigInt(256);
    return x - mod;
  }
  return x;
}

function pow10(n: number) {
  return BigInt(10) ** BigInt(n);
}

// AggregatorV3Interface.latestRoundData() selector (verified)
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';

export class ChainlinkWebSocket extends EventEmitter {
  private wssUrl: string;
  private feedAddress: string;
  private decimals: number;
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 50;

  private rpcId = 1;
  private subId: string | null = null;
  private pending: Map<number, { receivedAt: Date; blockTag: string | 'latest' }> = new Map();
  private inFlight = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastRoundId: string | null = null;
  private lastAnswer: number | null = null;

  constructor(params: { wssUrl: string; feedAddress: string; decimals: number }) {
    super();
    this.setMaxListeners(100);
    this.wssUrl = params.wssUrl;
    this.feedAddress = params.feedAddress.toLowerCase();
    this.decimals = params.decimals;
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) return Promise.resolve();
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wssUrl);

        this.ws.on('open', () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit('connected');
          this.subscribe();
          // Some feeds (or RPCs) may not return logs reliably; poll latestRoundData over WS.
          this.startPoller();
          resolve();
        });

        this.ws.on('message', (data) => this.handleMessage(data.toString()));

        this.ws.on('close', () => {
          this.isConnecting = false;
          this.stopPoller();
          this.emit('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (err) => {
          this.isConnecting = false;
          this.emit('error', err);
          reject(err);
        });
      } catch (e) {
        this.isConnecting = false;
        reject(e);
      }
    });
  }

  disconnect() {
    this.stopPoller();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private send(msg: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private subscribe() {
    // eth_subscribe logs
    const id = this.rpcId++;
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: this.feedAddress,
          // No topics filter: OCR2 feeds may not emit AnswerUpdated; we react to any log by pulling latestRoundData.
          // This stays WS-only because eth_call is also sent over the same WebSocket.
        },
      ],
    });
  }

  private requestLatestRoundData(receivedAt: Date, blockTag: string | 'latest' = 'latest') {
    if (this.inFlight) return;
    this.inFlight = true;
    const id = this.rpcId++;
    this.pending.set(id, { receivedAt, blockTag });
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'eth_call',
      params: [{ to: this.feedAddress, data: LATEST_ROUND_DATA_SELECTOR }, blockTag],
    });
  }

  private startPoller() {
    this.stopPoller();
    // Default 250ms. Still WS-only (eth_call sent over the same WS).
    const intervalMs = Number(process.env.CHAINLINK_POLL_MS || 250);
    this.pollInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.requestLatestRoundData(new Date(), 'latest');
    }, intervalMs);
  }

  private stopPoller() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // eth_call response
    if (msg?.id && typeof msg.result === 'string' && this.pending.has(msg.id)) {
      const ctx = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      this.inFlight = false;

      const out: string = msg.result;
      const hex = strip0x(out);
      if (hex.length < 64 * 5) return;

      const roundId = hexToBigInt(word(hex, 0)).toString();
      const answer = int256FromWord(word(hex, 1));
      const updatedAtSec = Number(hexToBigInt(word(hex, 3)));

      const price = Number(answer) / Number(pow10(this.decimals));
      // Only emit on actual change (round or answer)
      const changed = this.lastRoundId !== roundId || this.lastAnswer !== price;
      this.lastRoundId = roundId;
      this.lastAnswer = price;

      if (changed) {
        const update: ChainlinkPriceUpdate = {
          feedAddress: this.feedAddress,
          price,
          decimals: this.decimals,
          roundId,
          updatedAtSec,
          receivedAt: ctx.receivedAt,
        };
        this.emit('price', update);
      }
      return;
    }

    // subscription ack
    if (msg?.id && msg?.result && typeof msg.result === 'string') {
      this.subId = msg.result;
      this.emit('subscribed', { subId: this.subId });
      return;
    }

    // subscription event
    if (msg?.method === 'eth_subscription' && msg?.params?.result) {
      const ev = msg.params.result;
      const receivedAt = new Date();
      // trigger a WS eth_call to pull latestRoundData
      const blockTag = ev.blockNumber || 'latest';
      this.requestLatestRoundData(receivedAt, blockTag);
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 500 * this.reconnectAttempts);
    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }
}

let singleton: ChainlinkWebSocket | null = null;

export function getChainlinkBTCUSDWS(): ChainlinkWebSocket {
  const wssUrl = process.env.POLYGON_WSS_URL || '';
  const feedAddress =
    (process.env.CHAINLINK_BTC_USD_FEED_ADDRESS || '0xc907E116054Ad103354f2D350FD2514433D57F6f').toLowerCase();
  const decimals = Number(process.env.CHAINLINK_DECIMALS || 8);

  if (!wssUrl) {
    throw new Error('Missing POLYGON_WSS_URL (required for Chainlink WebSocket)');
  }

  if (!singleton) {
    singleton = new ChainlinkWebSocket({ wssUrl, feedAddress, decimals });
  }

  return singleton;
}

