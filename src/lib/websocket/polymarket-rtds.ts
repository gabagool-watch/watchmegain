/**
 * Polymarket RTDS (Real-Time Data Socket)
 *
 * Docs mention:
 * - URL: wss://ws-live-data.polymarket.com
 * - topic: "crypto_prices" for real-time crypto prices (used by Polymarket)
 *
 * We use this as the "Polymarket-side Chainlink-like" reference feed for BTC/USD.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

const RTDS_URL = process.env.POLYMARKET_RTDS_URL || 'wss://ws-live-data.polymarket.com';

export interface RTDSCryptoPrice {
  topic: 'crypto_prices' | 'crypto_prices_chainlink';
  symbol: string; // e.g. "btcusdt" or "btc/usd"
  value: number; // price
  payloadTimestamp: number; // ms epoch (when recorded)
  messageTimestamp: number; // ms epoch (when sent)
  raw?: unknown;
}

type RTDSMessage = {
  topic?: string;
  type?: string;
  timestamp?: number;
  payload?: any;
};

export class PolymarketRTDS extends EventEmitter {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 50;
  private pingTimer: NodeJS.Timeout | null = null;

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) return Promise.resolve();
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(RTDS_URL);

        this.ws.on('open', () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit('connected');

          // Keepalive: docs recommend sending PING every ~5s.
          this.startPing();

          // Subscribe to:
          // - Chainlink BTC/USD (topic: crypto_prices_chainlink, type: "*", filters: JSON string {"symbol":"btc/usd"})
          const chainlinkFilter = JSON.stringify({ symbol: 'btc/usd' });
          this.ws!.send(
            JSON.stringify({
              action: 'subscribe',
              subscriptions: [
                { topic: 'crypto_prices_chainlink', type: '*', filters: chainlinkFilter },
              ],
            })
          );

          resolve();
        });

        this.ws.on('message', (data) => this.handleMessage(data.toString()));

        this.ws.on('close', () => {
          this.isConnecting = false;
          this.stopPing();
          this.emit('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (err) => {
          this.isConnecting = false;
          this.stopPing();
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
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send('PING');
        }
      } catch {}
    }, 5000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(raw: string) {
    // Server may send ping/pong text frames
    if (raw === 'PING') {
      try {
        this.ws?.send('PONG');
      } catch {}
      return;
    }
    if (raw === 'PONG') return;

    let msg: RTDSMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const topic = msg.topic;
    if (topic !== 'crypto_prices' && topic !== 'crypto_prices_chainlink') return;
    if (msg.type !== 'update') {
      // docs show update; we keep it strict to reduce noise
      return;
    }

    const messageTimestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
    const p = msg.payload || {};
    const symbol = String(p.symbol || '');
    const payloadTimestamp = Number(p.timestamp ?? messageTimestamp);
    const value = Number(p.value);
    if (!symbol || !Number.isFinite(value) || !Number.isFinite(payloadTimestamp)) return;

    const u: RTDSCryptoPrice = {
      topic: topic as any,
      symbol,
      value,
      payloadTimestamp,
      messageTimestamp,
      raw: msg,
    };
    this.emit('crypto_price', u);
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 500 * this.reconnectAttempts);
    setTimeout(() => this.connect().catch(() => {}), delay);
  }
}

let singleton: PolymarketRTDS | null = null;

export function getPolymarketRTDS(): PolymarketRTDS {
  if (!singleton) singleton = new PolymarketRTDS();
  return singleton;
}

