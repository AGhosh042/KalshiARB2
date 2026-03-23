import WebSocket from 'ws';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { config } from '../config.js';

export interface PricePoint {
  price: number;
  timestamp: number; // Unix ms
}

export type Trend = 'up' | 'down' | 'flat';

export interface CoinbasePriceData {
  price: number;
  priceChangePct: number; // percentage, e.g. 0.05 means +0.05%
  trend: Trend;
  history: PricePoint[];
}

interface CoinbaseTickerEvent {
  type: string;
  channel?: string;
  product_id?: string;
  price?: string;
  events?: Array<{
    type: string;
    tickers?: Array<{
      type: string;
      product_id: string;
      price: string;
      volume_24_h?: string;
      low_52_w?: string;
      high_52_w?: string;
      price_percent_chg_24_h?: string;
      best_bid?: string;
      best_ask?: string;
      best_bid_quantity?: string;
      best_ask_quantity?: string;
    }>;
  }>;
}

export class CoinbaseClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private priceHistory: PricePoint[] = [];
  private latestPrice: number | null = null;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30_000;
  private baseReconnectDelay = 1_000;
  private isShuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  // Message watchdog: Coinbase Advanced Trade WS does not respond to WS-level ping frames.
  // Instead we track the last received message timestamp and terminate if silent for 45s.
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private static readonly MESSAGE_WATCHDOG_MS = 45_000;
  private static readonly WATCHDOG_CHECK_INTERVAL_MS = 10_000;

  constructor() {
    super();
  }

  private clearTimers(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }

  connect(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    // Clear price history on (re)connect — stale data from a prior session
    // would corrupt trend/EMA calculations on the fresh stream.
    this.priceHistory = [];

    logger.info('Connecting to Coinbase Advanced Trade WebSocket', {
      url: config.coinbase.wsUrl,
    });

    this.ws = new WebSocket(config.coinbase.wsUrl);

    this.ws.on('open', () => {
      logger.info('Coinbase WebSocket connected');
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.subscribe();

      // Coinbase Advanced Trade WS does not respond to WS-level ping frames.
      // Use a message watchdog instead: check every 10s that we received a
      // message in the last 45s. If silent, the connection is stale — reconnect.
      this.watchdogTimer = setInterval(() => {
        const silentMs = Date.now() - this.lastMessageAt;
        if (silentMs > CoinbaseClient.MESSAGE_WATCHDOG_MS) {
          logger.warn('Coinbase WebSocket: message watchdog timeout — reconnecting', { silentMs });
          this.ws?.terminate();
        }
      }, CoinbaseClient.WATCHDOG_CHECK_INTERVAL_MS);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(data.toString());
    });

    this.ws.on('error', (err: Error) => {
      logger.error('Coinbase WebSocket error', { error: err.message });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers();
      logger.warn('Coinbase WebSocket closed', {
        code,
        reason: reason.toString(),
      });
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Cannot subscribe: WebSocket not open');
      return;
    }

    const subscribeMsg = {
      type: 'subscribe',
      product_ids: [config.coinbase.productId],
      channel: 'ticker',
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.info('Subscribed to Coinbase ticker channel', {
      product: config.coinbase.productId,
    });
  }

  private handleMessage(raw: string): void {
    let msg: CoinbaseTickerEvent;
    try {
      msg = JSON.parse(raw) as CoinbaseTickerEvent;
    } catch (err) {
      logger.debug('Failed to parse Coinbase message', { raw: raw.slice(0, 200) });
      return;
    }

    // Advanced Trade WS commonly delivers ticker payloads in an events envelope:
    // { channel: "ticker", events: [{ type: "snapshot"|"update", tickers: [...] }] }
    // Some feeds/clients may still emit a flat ticker shape; support both.
    if (msg.events && Array.isArray(msg.events)) {
      for (const event of msg.events) {
        if (event.tickers && Array.isArray(event.tickers)) {
          for (const ticker of event.tickers) {
            if (ticker.product_id === config.coinbase.productId && ticker.price) {
              this.processTicker(ticker.price);
            }
          }
        }
      }
      return;
    }

    // Flat ticker fallback shape.
    if (msg.type === 'ticker' && msg.product_id === config.coinbase.productId && msg.price) {
      this.processTicker(msg.price);
      return;
    }

    // Non-price/control messages: subscriptions, heartbeats, etc.
    logger.debug('Coinbase non-ticker message', {
      type: msg.type,
      channel: msg.channel,
    });
  }

  private processTicker(priceStr: string): void {
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) {
      logger.warn('Received invalid price from Coinbase', { priceStr });
      return;
    }

    const now = Date.now();
    this.latestPrice = price;

    // Add to history
    this.priceHistory.push({ price, timestamp: now });

    // Prune history older than trendWindowSeconds
    const cutoff = now - config.strategy.trendWindowSeconds * 1000;
    this.priceHistory = this.priceHistory.filter((p) => p.timestamp >= cutoff);

    const data = this.computePriceData(price, now);
    this.emit('priceUpdate', data);

    logger.debug('Coinbase price update', {
      price,
      priceChangePct: data.priceChangePct.toFixed(4),
      trend: data.trend,
    });
  }

  private computePriceData(currentPrice: number, now: number): CoinbasePriceData {
    const windowMs = config.strategy.trendWindowSeconds * 1000;
    const cutoff = now - windowMs;

    // Find the oldest price point within the window
    const windowHistory = this.priceHistory.filter((p) => p.timestamp >= cutoff);
    const oldestInWindow = windowHistory.length > 0 ? windowHistory[0] : null;

    let priceChangePct = 0;
    if (oldestInWindow && oldestInWindow.price !== 0) {
      priceChangePct = ((currentPrice - oldestInWindow.price) / oldestInWindow.price) * 100;
    }

    const trend = this.computeTrend(priceChangePct);

    return {
      price: currentPrice,
      priceChangePct,
      trend,
      history: [...this.priceHistory],
    };
  }

  private computeTrend(priceChangePct: number): Trend {
    const threshold = config.strategy.priceMoveThresholdPct;
    if (priceChangePct > threshold) return 'up';
    if (priceChangePct < -threshold) return 'down';
    return 'flat';
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay
    );

    this.reconnectAttempt += 1;
    logger.info(`Scheduling Coinbase reconnect`, {
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      if (!this.isShuttingDown) {
        this.connect();
      }
    }, delay);
  }

  getLatestData(): CoinbasePriceData | null {
    if (this.latestPrice === null) return null;
    return this.computePriceData(this.latestPrice, Date.now());
  }

  disconnect(): void {
    this.isShuttingDown = true;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      logger.info('Disconnecting Coinbase WebSocket');
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
  }
}
