"use strict";
/**
 * KalshiWsClient — real-time Kalshi market data via WebSocket.
 *
 * Subscribes to the `ticker` channel (public, no auth required for market data).
 * Emits KalshiMarket objects whenever Kalshi pushes a price update.
 *
 * Replaces the REST polling loop — zero REST calls for market data,
 * push latency instead of poll latency, no rate limit consumption.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KalshiWsClient = void 0;
const ws_1 = __importDefault(require("ws"));
const crypto_1 = __importDefault(require("crypto"));
const events_1 = require("events");
const logger_js_1 = __importDefault(require("../utils/logger.js"));
const config_js_1 = require("../config.js");
class KalshiWsClient extends events_1.EventEmitter {
    ws = null;
    marketTicker;
    reconnectDelayMs = 1000;
    active = false;
    pingTimer = null;
    pongTimeout = null;
    msgId = 1;
    // Tracks the last known market state — patched incrementally as ticks arrive.
    latestMarket = null;
    latestMarketTimestamp = 0; // ms timestamp of last tick
    // RSA key for authenticated WS connection (needed for private channels, optional for ticker).
    apiKeyId;
    privateKey;
    constructor(marketTicker, privateKey, apiKeyId, seedMarket) {
        super();
        this.marketTicker = marketTicker;
        this.privateKey = privateKey;
        this.apiKeyId = apiKeyId;
        // Pre-populate with REST data so expiration_value_dollars is available
        // immediately (WS ticker ticks may not include it on every message).
        this.latestMarket = seedMarket ?? null;
    }
    /** Build auth headers for the WS handshake (same signing as REST). */
    buildAuthHeaders() {
        if (!this.privateKey || !this.apiKeyId)
            return {};
        const timestampMs = Date.now().toString();
        const path = '/trade-api/ws/v2';
        const msgToSign = `${timestampMs}GET${path}`;
        const signer = crypto_1.default.createSign('RSA-SHA256');
        signer.update(msgToSign, 'utf8');
        signer.end();
        const signature = signer.sign({ key: this.privateKey, padding: crypto_1.default.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, 'base64');
        return {
            'KALSHI-ACCESS-KEY': this.apiKeyId,
            'KALSHI-ACCESS-SIGNATURE': signature,
            'KALSHI-ACCESS-TIMESTAMP': timestampMs,
        };
    }
    /** Switch to a new market ticker — resubscribes on the existing connection. */
    setMarketTicker(ticker) {
        if (ticker === this.marketTicker)
            return;
        logger_js_1.default.info('KalshiWsClient: switching market ticker', { from: this.marketTicker, to: ticker });
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
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
    connect() {
        this.active = true;
        this.doConnect();
    }
    doConnect() {
        if (!this.active)
            return;
        // Build the WS URL robustly:
        // 1. Strip trailing slash, 2. swap http(s) scheme to ws(s),
        // 3. Replace the REST path suffix with the WS path.
        // Using explicit replacements is safer than naive string concat.
        const wsUrl = config_js_1.config.kalshi.baseUrl
            .replace(/\/+$/, '') // strip trailing slashes
            .replace(/^https:\/\//, 'wss://')
            .replace(/^http:\/\//, 'ws://')
            .replace(/\/trade-api\/v2$/, '/trade-api/ws/v2');
        logger_js_1.default.info('KalshiWsClient: connecting', { url: wsUrl, ticker: this.marketTicker });
        const headers = this.buildAuthHeaders();
        this.ws = new ws_1.default(wsUrl, { headers });
        this.ws.on('open', () => {
            logger_js_1.default.info('KalshiWsClient: connected');
            this.reconnectDelayMs = 1000; // reset backoff on success
            // Subscribe to ticker channel for our market.
            this.ws.send(JSON.stringify({
                id: this.msgId++,
                cmd: 'subscribe',
                params: { channels: ['ticker'], market_tickers: [this.marketTicker] },
            }));
            // Heartbeat ping every 30s to keep connection alive.
            // If no pong arrives within 10s, terminate — TCP may be silently dead.
            this.pingTimer = setInterval(() => {
                if (this.ws?.readyState === ws_1.default.OPEN) {
                    this.ws.ping();
                    this.pongTimeout = setTimeout(() => {
                        logger_js_1.default.warn('KalshiWsClient: pong timeout — terminating stale connection');
                        this.ws?.terminate();
                    }, 10_000);
                }
            }, 30_000);
            // Clear pong timeout on receipt.
            this.ws.on('pong', () => {
                if (this.pongTimeout) {
                    clearTimeout(this.pongTimeout);
                    this.pongTimeout = null;
                }
            });
            this.emit('connected');
        });
        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            }
            catch {
                // Ignore parse errors
            }
        });
        this.ws.on('close', (code, reason) => {
            this.cleanup();
            const reasonStr = reason.toString() || 'unknown';
            logger_js_1.default.warn('KalshiWsClient: disconnected', { code, reason: reasonStr });
            this.emit('disconnected', code, reasonStr);
            if (this.active) {
                logger_js_1.default.info(`KalshiWsClient: reconnecting in ${this.reconnectDelayMs}ms`);
                setTimeout(() => this.doConnect(), this.reconnectDelayMs);
                this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
            }
        });
        this.ws.on('error', (err) => {
            logger_js_1.default.error('KalshiWsClient: error', { error: err.message });
            this.emit('error', err);
        });
    }
    cleanup() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }
    handleMessage(msg) {
        const type = msg['type'];
        const payload = msg['msg'];
        if (!type || !payload)
            return;
        if (type === 'ticker') {
            this.patchAndEmit(payload);
        }
        else if (type === 'error') {
            const errMsg = payload;
            logger_js_1.default.error('KalshiWsClient: server error', { code: errMsg.code, msg: errMsg.msg });
        }
    }
    patchAndEmit(tick) {
        const ticker = tick.market_ticker ?? this.marketTicker;
        // WS ticker sends prices in dollars (yes_bid_dollars etc.), not cents like REST.
        // Convert back to cents for KalshiMarket (which uses cent-denominated prices throughout).
        const toBidAskCents = (dollars, fallback) => {
            if (dollars != null && !isNaN(dollars))
                return Math.round(dollars * 100);
            return fallback;
        };
        // Build or patch the market state from the tick.
        const prev = this.latestMarket;
        const market = {
            ticker,
            yes_bid: toBidAskCents(tick.yes_bid_dollars, prev?.yes_bid ?? 0),
            yes_ask: toBidAskCents(tick.yes_ask_dollars, prev?.yes_ask ?? 0),
            no_bid: toBidAskCents(tick.no_bid_dollars, prev?.no_bid ?? 0),
            no_ask: toBidAskCents(tick.no_ask_dollars, prev?.no_ask ?? 0),
            volume: tick.volume ?? prev?.volume ?? 0,
            open_interest: tick.open_interest ?? prev?.open_interest ?? 0,
            status: (tick.status ?? prev?.status ?? 'open'),
            close_time: tick.close_time ?? prev?.close_time ?? '',
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
    getLatestMarket() {
        return this.latestMarket;
    }
    /** Returns ms since the last market tick was received. Used to detect stale data. */
    getUnderlyingAgeMsMs() {
        if (this.latestMarketTimestamp === 0)
            return Infinity;
        return Date.now() - this.latestMarketTimestamp;
    }
    /** Gracefully close the connection. */
    disconnect() {
        this.active = false;
        this.cleanup();
        if (this.ws) {
            this.ws.close(1000, 'client disconnect');
            this.ws = null;
        }
    }
}
exports.KalshiWsClient = KalshiWsClient;
//# sourceMappingURL=wsClient.js.map