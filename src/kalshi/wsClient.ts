/**
 * KalshiWsClient — real-time Kalshi market data via WebSocket.
 *
 * Subscribes to the `ticker` channel (public, no auth required for market data).
 * Emits KalshiMarket objects whenever Kalshi pushes a price update.
 *
 * Replaces the REST polling loop — zero REST calls for market data,
 * push latency instead of poll latency, no rate limit consumption.
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { config } from '../config.js';
import type { KalshiMarket } from './types.js';

export interface KalshiWsClientEvents {
  market: (market: KalshiMarket) => void;
  connected: () => void;
  disconnected: (code: number, reason: string) => void;
  error: (err: Error) => void;
}

export declare interface KalshiWsClient {
  on<K extends keyof KalshiWsClientEvents>(event: K, listener: KalshiWsClientEvents[K]): this;
  emit<K extends keyof KalshiWsClientEvents>(event: K, ...args: Parameters<KalshiWsClientEvents[K]>): boolean;
}

interface TickerMsg {
  // WS ticker sends dollar-denominated prices (NOT cents like REST API)
  yes_bid_dollars?: number;
  yes_ask_dollars?: number;
  no_bid_dollars?: number;
  no_ask_dollars?: number;
  // WS also sends underlying BTC price and strike directly
  underlying_price?: number;        // live Kalshi BTC index (dollars)
  expiration_value?: string | number; // market strike price (dollars or string like "$85,000")
  volume?: number;
  open_interest?: number;
  status?: string;
  close_time?: string;
  market_ticker?: string;
  [key: string]: unknown;
}

export class KalshiWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private marketTicker: string;
  private reconnectDelayMs = 1000;
  private active = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private msgId = 1;

  // Tracks the last known market state — patched incrementally as ticks arrive.
  private latestMarket: KalshiMarket | null = null;
  private latestMarketTimestamp = 0; // ms timestamp of last tick

  // RSA key for authenticated WS connection (needed for private channels, optional for ticker).
  private readonly apiKeyId: string;
  private readonly privateKey: crypto.KeyObject | null;

  constructor(
    marketTicker: string,
    privateKey: crypto.KeyObject | null,
    apiKeyId: string,
    seedMarket?: KalshiMarket,
  ) {
    super();
    this.marketTicker = marketTicker;
    this.privateKey = privateKey;
    this.apiKeyId = apiKeyId;
    // Pre-populate with REST data so expiration_value_dollars is available
    // immediately (WS ticker ticks may not include it on every message).
    this.latestMarket = seedMarket ?? null;
  }

  /** Build auth headers for the WS handshake (same signing as REST). */
  private buildAuthHeaders(): Record<string, string> {
    if (!this.privateKey || !this.apiKeyId) return {};

    const timestampMs = Date.now().toString();
    const path = '/trade-api/ws/v2';
    const msgToSign = `${timestampMs}GET${path}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(msgToSign, 'utf8');
    signer.end();
    const signature = signer.sign(
      { key: this.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      'base64',
    );

    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    };
  }

  /** Switch to a new market ticker — resubscribes on the existing connection. */
  setMarketTicker(ticker: string): void {
    if (ticker === this.marketTicker) return;

    logger.info('KalshiWsClient: switching market ticker', { from: this.marketTicker, to: ticker });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Unsubscribe old ticker.
      this.ws.send(JSON.stringify({
        id: this.msgId++,
        cmd: 'unsubscribe',
        params: { channels: ['ticker'], market_tickers: [this.marketTicker] },
      }));
      // Subscribe new ticker.
      this.ws.send(JSON.stringify({
        id: this.msgId++,
        cmd: 'subscribe',
        params: { channels: ['ticker'], market_tickers: [ticker] },
      }));
    }

    this.marketTicker = ticker;
    this.latestMarket = null;
  }

  /** Connect and start streaming. Reconnects automatically on disconnect. */
  connect(): void {
    this.active = true;
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.active) return;

    // Build the WS URL robustly:
    // 1. Strip trailing slash, 2. swap http(s) scheme to ws(s),
    // 3. Replace the REST path suffix with the WS path.
    // Using explicit replacements is safer than naive string concat.
    const wsUrl = config.kalshi.baseUrl
      .replace(/\/+$/, '')           // strip trailing slashes
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      .replace(/\/trade-api\/v2$/, '/trade-api/ws/v2');

    logger.info('KalshiWsClient: connecting', { url: wsUrl, ticker: this.marketTicker });

    const headers = this.buildAuthHeaders();
    this.ws = new WebSocket(wsUrl, { headers });

    this.ws.on('open', () => {
      logger.info('KalshiWsClient: connected');
      this.reconnectDelayMs = 1000; // reset backoff on success

      // Subscribe to ticker channel for our market.
      this.ws!.send(JSON.stringify({
        id: this.msgId++,
        cmd: 'subscribe',
        params: { channels: ['ticker'], market_tickers: [this.marketTicker] },
      }));

      // Heartbeat ping every 30s to keep connection alive.
      // If no pong arrives within 10s, terminate — TCP may be silently dead.
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
          this.pongTimeout = setTimeout(() => {
            logger.warn('KalshiWsClient: pong timeout — terminating stale connection');
            this.ws?.terminate();
          }, 10_000);
        }
      }, 30_000);

      // Clear pong timeout on receipt.
      this.ws!.on('pong', () => {
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
      });

      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        // Ignore parse errors
      }
    });

    this.ws.on('close', (code, reason) => {
      this.cleanup();
      const reasonStr = reason.toString() || 'unknown';
      logger.warn('KalshiWsClient: disconnected', { code, reason: reasonStr });
      this.emit('disconnected', code, reasonStr);

      if (this.active) {
        logger.info(`KalshiWsClient: reconnecting in ${this.reconnectDelayMs}ms`);
        setTimeout(() => this.doConnect(), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      }
    });

    this.ws.on('error', (err) => {
      logger.error('KalshiWsClient: error', { error: err.message });
      this.emit('error', err);
    });
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string | undefined;
    const payload = msg['msg'] as TickerMsg | undefined;

    if (!type || !payload) return;

    if (type === 'ticker') {
      this.patchAndEmit(payload);
    } else if (type === 'error') {
      const errMsg = payload as unknown as { code?: string; msg?: string };
      logger.error('KalshiWsClient: server error', { code: errMsg.code, msg: errMsg.msg });
    }
  }

  private patchAndEmit(tick: TickerMsg): void {
    const ticker = (tick.market_ticker as string | undefined) ?? this.marketTicker;

    // WS ticker sends prices in dollars (yes_bid_dollars etc.), not cents like REST.
    // Convert back to cents for KalshiMarket (which uses cent-denominated prices throughout).
    const toBidAskCents = (dollars: number | undefined, fallback: number): number => {
      if (dollars != null && !isNaN(dollars)) return Math.round(dollars * 100);
      return fallback;
    };

    // Build or patch the market state from the tick.
    const prev = this.latestMarket;
    const market: KalshiMarket = {
      ticker,
      yes_bid: toBidAskCents(tick.yes_bid_dollars, prev?.yes_bid ?? 0),
      yes_ask: toBidAskCents(tick.yes_ask_dollars, prev?.yes_ask ?? 0),
      no_bid:  toBidAskCents(tick.no_bid_dollars,  prev?.no_bid  ?? 0),
      no_ask:  toBidAskCents(tick.no_ask_dollars,  prev?.no_ask  ?? 0),
      volume:        tick.volume        ?? prev?.volume        ?? 0,
      open_interest: tick.open_interest ?? prev?.open_interest ?? 0,
      status:   ((tick.status ?? prev?.status ?? 'open') as KalshiMarket['status']),
      close_time: (tick.close_time as string | undefined) ?? prev?.close_time ?? '',
      // underlying_price = live Kalshi BTC index in dollars (what the dashboard shows as "Kalshi price")
      last_price_dollars: tick.underlying_price != null && !isNaN(tick.underlying_price)
        ? tick.underlying_price
        : prev?.last_price_dollars,
      // expiration_value = the strike price in dollars for this contract
      expiration_value_dollars: (() => {
        if (tick.expiration_value != null) {
          const parsed = parseFloat(String(tick.expiration_value).replace(/[^0-9.]/g, ''));
          return isNaN(parsed) ? prev?.expiration_value_dollars : parsed;
        }
        return prev?.expiration_value_dollars;
      })(),
    };

    this.latestMarket = market;
    this.latestMarketTimestamp = Date.now();
    this.emit('market', market);
  }

  /** Get the last known market state without waiting for the next tick. */
  getLatestMarket(): KalshiMarket | null {
    return this.latestMarket;
  }

  /** Returns ms since the last market tick was received. Used to detect stale data. */
  getUnderlyingAgeMsMs(): number {
    if (this.latestMarketTimestamp === 0) return Infinity;
    return Date.now() - this.latestMarketTimestamp;
  }

  /** Gracefully close the connection. */
  disconnect(): void {
    this.active = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }
}
