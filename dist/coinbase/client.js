"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoinbaseClient = void 0;
const ws_1 = __importDefault(require("ws"));
const events_1 = require("events");
const logger_js_1 = __importDefault(require("../utils/logger.js"));
const config_js_1 = require("../config.js");
class CoinbaseClient extends events_1.EventEmitter {
    ws = null;
    priceHistory = [];
    latestPrice = null;
    reconnectAttempt = 0;
    maxReconnectDelay = 30_000;
    baseReconnectDelay = 1_000;
    isShuttingDown = false;
    reconnectTimer = null;
    // Message watchdog: Coinbase Advanced Trade WS does not respond to WS-level ping frames.
    // Instead we track the last received message timestamp and terminate if silent for 45s.
    watchdogTimer = null;
    lastMessageAt = 0;
    static MESSAGE_WATCHDOG_MS = 45_000;
    static WATCHDOG_CHECK_INTERVAL_MS = 10_000;
    constructor() {
        super();
    }
    clearTimers() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }
    connect() {
        this.clearTimers();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = null;
        }
        // Clear price history on (re)connect — stale data from a prior session
        // would corrupt trend/EMA calculations on the fresh stream.
        this.priceHistory = [];
        logger_js_1.default.info('Connecting to Coinbase Advanced Trade WebSocket', {
            url: config_js_1.config.coinbase.wsUrl,
        });
        this.ws = new ws_1.default(config_js_1.config.coinbase.wsUrl);
        this.ws.on('open', () => {
            logger_js_1.default.info('Coinbase WebSocket connected');
            this.reconnectAttempt = 0;
            this.lastMessageAt = Date.now();
            this.subscribe();
            // Coinbase Advanced Trade WS does not respond to WS-level ping frames.
            // Use a message watchdog instead: check every 10s that we received a
            // message in the last 45s. If silent, the connection is stale — reconnect.
            this.watchdogTimer = setInterval(() => {
                const silentMs = Date.now() - this.lastMessageAt;
                if (silentMs > CoinbaseClient.MESSAGE_WATCHDOG_MS) {
                    logger_js_1.default.warn('Coinbase WebSocket: message watchdog timeout — reconnecting', { silentMs });
                    this.ws?.terminate();
                }
            }, CoinbaseClient.WATCHDOG_CHECK_INTERVAL_MS);
        });
        this.ws.on('message', (data) => {
            this.lastMessageAt = Date.now();
            this.handleMessage(data.toString());
        });
        this.ws.on('error', (err) => {
            logger_js_1.default.error('Coinbase WebSocket error', { error: err.message });
        });
        this.ws.on('close', (code, reason) => {
            this.clearTimers();
            logger_js_1.default.warn('Coinbase WebSocket closed', {
                code,
                reason: reason.toString(),
            });
            if (!this.isShuttingDown) {
                this.scheduleReconnect();
            }
        });
    }
    subscribe() {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            logger_js_1.default.warn('Cannot subscribe: WebSocket not open');
            return;
        }
        const subscribeMsg = {
            type: 'subscribe',
            product_ids: [config_js_1.config.coinbase.productId],
            channel: 'ticker',
        };
        this.ws.send(JSON.stringify(subscribeMsg));
        logger_js_1.default.info('Subscribed to Coinbase ticker channel', {
            product: config_js_1.config.coinbase.productId,
        });
    }
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch (err) {
            logger_js_1.default.debug('Failed to parse Coinbase message', { raw: raw.slice(0, 200) });
            return;
        }
        // Advanced Trade WS commonly delivers ticker payloads in an events envelope:
        // { channel: "ticker", events: [{ type: "snapshot"|"update", tickers: [...] }] }
        // Some feeds/clients may still emit a flat ticker shape; support both.
        if (msg.events && Array.isArray(msg.events)) {
            for (const event of msg.events) {
                if (event.tickers && Array.isArray(event.tickers)) {
                    for (const ticker of event.tickers) {
                        if (ticker.product_id === config_js_1.config.coinbase.productId && ticker.price) {
                            this.processTicker(ticker.price);
                        }
                    }
                }
            }
            return;
        }
        // Flat ticker fallback shape.
        if (msg.type === 'ticker' && msg.product_id === config_js_1.config.coinbase.productId && msg.price) {
            this.processTicker(msg.price);
            return;
        }
        // Non-price/control messages: subscriptions, heartbeats, etc.
        logger_js_1.default.debug('Coinbase non-ticker message', {
            type: msg.type,
            channel: msg.channel,
        });
    }
    processTicker(priceStr) {
        const price = parseFloat(priceStr);
        if (isNaN(price) || price <= 0) {
            logger_js_1.default.warn('Received invalid price from Coinbase', { priceStr });
            return;
        }
        const now = Date.now();
        this.latestPrice = price;
        // Add to history
        this.priceHistory.push({ price, timestamp: now });
        // Prune history older than trendWindowSeconds
        const cutoff = now - config_js_1.config.strategy.trendWindowSeconds * 1000;
        this.priceHistory = this.priceHistory.filter((p) => p.timestamp >= cutoff);
        const data = this.computePriceData(price, now);
        this.emit('priceUpdate', data);
        logger_js_1.default.debug('Coinbase price update', {
            price,
            priceChangePct: data.priceChangePct.toFixed(4),
            trend: data.trend,
        });
    }
    computePriceData(currentPrice, now) {
        const windowMs = config_js_1.config.strategy.trendWindowSeconds * 1000;
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
    computeTrend(priceChangePct) {
        const threshold = config_js_1.config.strategy.priceMoveThresholdPct;
        if (priceChangePct > threshold)
            return 'up';
        if (priceChangePct < -threshold)
            return 'down';
        return 'flat';
    }
    scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempt), this.maxReconnectDelay);
        this.reconnectAttempt += 1;
        logger_js_1.default.info(`Scheduling Coinbase reconnect`, {
            attempt: this.reconnectAttempt,
            delayMs: delay,
        });
        this.reconnectTimer = setTimeout(() => {
            if (!this.isShuttingDown) {
                this.connect();
            }
        }, delay);
    }
    getLatestData() {
        if (this.latestPrice === null)
            return null;
        return this.computePriceData(this.latestPrice, Date.now());
    }
    disconnect() {
        this.isShuttingDown = true;
        this.clearTimers();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            logger_js_1.default.info('Disconnecting Coinbase WebSocket');
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = null;
        }
    }
}
exports.CoinbaseClient = CoinbaseClient;
//# sourceMappingURL=client.js.map