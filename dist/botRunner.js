"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotRunner = void 0;
const config_js_1 = require("./config.js");
const logger_js_1 = __importDefault(require("./utils/logger.js"));
const client_js_1 = require("./coinbase/client.js");
const client_js_2 = require("./kalshi/client.js");
const wsClient_js_1 = require("./kalshi/wsClient.js");
const arbStrategy_js_1 = require("./strategy/arbStrategy.js");
class BotRunner {
    coinbaseClient = null;
    kalshiClient = null;
    strategy = null;
    latestCoinbaseData = null;
    lastKalshiUnderlyingPriceDollars = null;
    demoUnderlyingLastDollars = null;
    // Demo synthetic market "strike"/expiration_value. Prefer Kalshi-derived
    // value so the demo UI doesn't show a stale/static strike.
    demoTargetDollars = null;
    lastCoinbaseUpdateAtMs = null;
    lastKalshiUnderlyingUpdateAtMs = null;
    lastEvalAtMs = null;
    // Demo-only synthetic Coinbase feed (so demo can run without relying on WS connectivity).
    demoCoinbaseTimer = null;
    demoCoinbaseStartAtMs = 0;
    demoCoinbasePriceDollars = 0;
    demoCoinbaseHistory = [];
    buildDemoMarket(ticker, coinbasePriceDollars) {
        const strike = this.demoTargetDollars ?? config_js_1.config.strategy.referencePriceDollars;
        const underlyingOld = this.demoUnderlyingLastDollars ?? config_js_1.config.strategy.demoKalshiUnderlyingDollars;
        // Demo-only: make the synthetic "Kalshi underlying" lag Coinbase so diff sign changes occur,
        // producing observable cross events on the dashboard.
        const alpha = 0.05; // 0..1; higher => less lag, lower => more lag
        const underlying = underlyingOld + alpha * (coinbasePriceDollars - underlyingOld);
        this.demoUnderlyingLastDollars = underlying;
        // Map underlying->implied YES probability using the same linear sigmoid approximation
        // used elsewhere in the strategy:
        // theoretical_yes_prob = 50 + (deltaPct / 0.1) * 15 clamped to [20,80]
        const deltaPct = ((underlying - strike) / strike) * 100;
        const raw = 50 + (deltaPct / 0.1) * 15;
        const theoreticalYesProb = Math.max(20, Math.min(80, raw));
        const yesMidCents = Math.max(1, Math.min(99, Math.round(theoreticalYesProb)));
        const spread = 2; // cents
        const yes_bid = Math.max(1, Math.min(99, yesMidCents - 1));
        const yes_ask = Math.max(1, Math.min(99, yesMidCents + 1));
        const noMidCents = Math.max(1, Math.min(99, 100 - yesMidCents));
        const no_bid = Math.max(1, Math.min(99, noMidCents - 1));
        const no_ask = Math.max(1, Math.min(99, noMidCents + 1));
        const closeTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        return {
            ticker,
            yes_bid,
            yes_ask,
            no_bid,
            no_ask,
            last_price_dollars: underlying,
            expiration_value_dollars: strike,
            volume: 0,
            open_interest: 0,
            status: 'open',
            close_time: closeTime,
        };
    }
    /**
     * Build the Kalshi ticker suffix from a close date.
     * Actual API format: {YY}{MON}{DD}{HHMM}-{MM}
     * e.g. close = 2026-03-20T21:45:00Z → "26MAR201745-45"
     */
    formatTickerSuffix(date, timeZone) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: '2-digit',
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date);
        const year = parts.find((p) => p.type === 'year')?.value ?? '00';
        const day = parts.find((p) => p.type === 'day')?.value ?? '01';
        const monthShort = parts.find((p) => p.type === 'month')?.value ?? 'Jan';
        const month = monthShort.toUpperCase().replace('.', '');
        const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
        const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
        // Format: {YY}{MON}{DD}{HHMM}-{MM}  (suffix = minute of close time)
        return `${year}${month}${day}${hour}${minute}-${minute}`;
    }
    parseRotationMinutesFromPrefix(prefix) {
        // Example prefix: "kxbtc15m" -> 15 minutes
        const m = prefix.match(/(\d+)m/i);
        return m ? Math.max(1, parseInt(m[1], 10)) : 15;
    }
    isNotFoundMarketError(err) {
        const msg = err instanceof Error ? err.message : String(err);
        return /\[404\]|status code 404|not found/i.test(msg);
    }
    buildTickerFromPrefixAndClose(prefix, closeDate) {
        return `${prefix.toUpperCase()}-${this.formatTickerSuffix(closeDate, 'America/New_York')}`;
    }
    /**
     * If the configured ticker has rolled over, try nearby rotation slots and switch
     * to the first market that resolves successfully.
     */
    async recoverLiveTickerOn404() {
        if (!this.kalshiClient)
            return null;
        const currentPrefix = this.currentMarketTicker.split('-')[0];
        const seriesTicker = currentPrefix.toUpperCase();
        // Preferred path: ask Kalshi for currently open markets in this series.
        try {
            const openSeriesMarkets = await this.kalshiClient.getMarkets({
                seriesTicker,
                status: 'open',
                limit: 100,
            });
            const now = Date.now();
            const candidates = openSeriesMarkets
                .filter((m) => m.ticker && m.close_time)
                .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())
                .filter((m) => new Date(m.close_time).getTime() >= now - 30_000);
            const best = candidates[0];
            if (best && best.ticker !== this.currentMarketTicker) {
                logger_js_1.default.warn('Recovered live ticker from open series markets', {
                    from: this.currentMarketTicker,
                    to: best.ticker,
                    seriesTicker,
                });
                this.currentMarketTicker = best.ticker;
                if (this.state)
                    this.state.marketTicker = best.ticker;
                return best;
            }
            if (best && best.ticker === this.currentMarketTicker) {
                return best;
            }
        }
        catch (err) {
            logger_js_1.default.warn('getMarkets failed during ticker recovery', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }
    computeNextMarketTicker(market) {
        const timeZone = 'America/New_York';
        const prefix = market.ticker.split('-')[0];
        const rotationMinutes = this.parseRotationMinutesFromPrefix(prefix);
        const closeMs = new Date(market.close_time).getTime();
        const nextClose = new Date(closeMs + rotationMinutes * 60 * 1000);
        const suffix = this.formatTickerSuffix(nextClose, timeZone);
        return `${prefix}-${suffix}`;
    }
    pollTimer = null;
    balanceLogTimer = null;
    isEvaluating = false;
    latestMarket = null;
    kalshiFetchLoopActive = false;
    kalshiWsClient = null;
    state = null;
    trades = [];
    startBalanceCents = 0;
    lastStateUpdateMs = 0;
    // Current Kalshi market ticker in use (supports auto-rotation).
    currentMarketTicker = config_js_1.config.kalshi.marketTicker;
    getState() {
        return this.state;
    }
    setBreakevenClose(enabled) {
        this.strategy?.setCloseAtBreakeven(enabled);
        if (this.state)
            this.state.breakevenCloseEnabled = enabled;
    }
    isBreakevenCloseEnabled() {
        return this.strategy?.isCloseAtBreakevenEnabled() ?? false;
    }
    getTrades() {
        return [...this.trades];
    }
    async start(mode, theoreticalBalanceDollars, demoUnderlyingDollars, demoTargetDollars) {
        if (this.pollTimer) {
            await this.stop();
        }
        // Configure the bot mode before instantiating clients/strategy.
        config_js_1.config.dryRun = mode === 'demo';
        if (mode === 'demo') {
            config_js_1.config.paperBalanceCents = Math.max(0, Math.round(theoreticalBalanceDollars * 100));
            if (demoUnderlyingDollars !== undefined && !Number.isNaN(demoUnderlyingDollars)) {
                config_js_1.config.strategy.demoKalshiUnderlyingDollars = demoUnderlyingDollars;
            }
            // Initialize demo synthetic underlying state for the lagged market.
            this.demoUnderlyingLastDollars = config_js_1.config.strategy.demoKalshiUnderlyingDollars;
            // Initialize demo synthetic strike. We'll try to refresh from Kalshi
            // after we create the Kalshi client.
            const fallbackTarget = demoTargetDollars !== undefined && !Number.isNaN(demoTargetDollars)
                ? demoTargetDollars
                : config_js_1.config.strategy.referencePriceDollars;
            this.demoTargetDollars = fallbackTarget;
        }
        // Initialize ticker rotation state.
        this.currentMarketTicker = config_js_1.config.kalshi.marketTicker;
        logger_js_1.default.info('Starting bot runner', {
            mode,
            theoreticalBalanceCents: config_js_1.config.paperBalanceCents,
            marketTicker: config_js_1.config.kalshi.marketTicker,
        });
        this.latestCoinbaseData = null;
        this.trades = [];
        this.isEvaluating = false;
        this.coinbaseClient = new client_js_1.CoinbaseClient();
        // In demo mode we don't need Kalshi connectivity; we still create a KalshiClient
        // instance because ArbStrategy expects it, but we will never call getMarket() from BotRunner.
        this.kalshiClient = new client_js_2.KalshiClient();
        this.strategy = new arbStrategy_js_1.ArbStrategy(this.kalshiClient);
        // Demo mode: best-effort fetch Kalshi expiration_value/target so the
        // dashboard doesn't rely on a static referencePriceDollars.
        if (mode === 'demo') {
            try {
                const market = await this.kalshiClient.getMarket(this.currentMarketTicker);
                const target = market.expiration_value_dollars;
                if (target !== undefined && !Number.isNaN(target)) {
                    this.demoTargetDollars = target;
                }
            }
            catch (err) {
                logger_js_1.default.warn('Demo mode: failed to fetch Kalshi target/strike', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        // Initialize dashboard state.
        if (mode === 'demo') {
            this.startBalanceCents = this.strategy.getDemoStartingCashCents();
        }
        else {
            this.startBalanceCents = await this.kalshiClient.getBalance();
        }
        this.state = {
            mode,
            running: true,
            startBalanceCents: this.startBalanceCents,
            currentBalanceCents: this.startBalanceCents,
            pnlCents: 0,
            updatedAt: Date.now(),
            positionContracts: 0,
            positionSide: 'flat',
            openOrdersCount: 0,
            lastCrossDirection: null,
            lastCrossAtMs: null,
            armedTpExitLimitCents: null,
            armedTpExitSide: null,
            lastCoinbasePriceDollars: null,
            lastKalshiUnderlyingPriceDollars: null,
            lastTargetPriceDollars: null,
            lastCoinbaseUpdateAtMs: null,
            lastKalshiUnderlyingUpdateAtMs: null,
            lastEvalAtMs: null,
            coinbaseMinusUnderlyingDollars: null,
            coinbaseMinusUnderlyingPct: null,
            coinbaseMinusUnderlyingSign: null,
            coinbaseDirection: null,
            currentTradeSide: null,
            currentTradeEntryLimitCents: null,
            currentTradeCount: null,
            currentTradePnLCents: null,
            currentTradePnLMode: null,
            marketTicker: this.currentMarketTicker,
            breakevenCloseEnabled: false,
        };
        if (mode === 'demo') {
            this.state.lastTargetPriceDollars = this.demoTargetDollars;
        }
        // Core evaluation: runs after both coinbase data and kalshi market are available.
        const evaluateWithMarket = async (coinbaseData, market) => {
            if (!this.coinbaseClient || !this.kalshiClient || !this.strategy || !this.state)
                return;
            if (this.isEvaluating)
                return;
            this.isEvaluating = true;
            try {
                // Dashboard reference: use the fixed strike price (expiration_value_dollars),
                // which is what the strategy actually compares coinbase against.
                // last_price_dollars is a synthetic EMA and produces a nearly-zero diff,
                // making the dashboard misleading. The strike diff is what determines trades.
                const target = market.expiration_value_dollars ?? null;
                const underlying = target; // strike is the "underlying" reference for display
                const coinbasePrice = coinbaseData.price;
                if (underlying !== null && !Number.isNaN(underlying)) {
                    this.lastKalshiUnderlyingPriceDollars = underlying;
                    this.lastKalshiUnderlyingUpdateAtMs = Date.now();
                    if (this.state) {
                        this.state.lastKalshiUnderlyingPriceDollars = underlying;
                        this.state.lastTargetPriceDollars = target;
                        this.state.lastCoinbasePriceDollars = coinbasePrice;
                        this.state.coinbaseMinusUnderlyingDollars = coinbasePrice - underlying;
                        this.state.coinbaseMinusUnderlyingPct = underlying
                            ? ((coinbasePrice - underlying) / underlying) * 100
                            : null;
                        const diff = coinbasePrice - underlying;
                        this.state.coinbaseMinusUnderlyingSign =
                            diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'zero';
                        this.state.updatedAt = Date.now();
                    }
                }
                const result = await this.strategy.evaluate(coinbaseData, market);
                const didTrade = this.maybeRecordTrade(result);
                const now = Date.now();
                const shouldUpdate = mode === 'demo' || didTrade || now - this.lastStateUpdateMs >= 2000;
                if (shouldUpdate) {
                    this.lastEvalAtMs = now;
                    await this.updateDashboardState(mode);
                    this.lastStateUpdateMs = now;
                }
            }
            catch (err) {
                logger_js_1.default.error('Unhandled error in evaluation', {
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined,
                });
            }
            finally {
                this.isEvaluating = false;
            }
        };
        if (mode === 'live') {
            this.coinbaseClient.on('priceUpdate', (data) => {
                this.latestCoinbaseData = data;
                this.lastCoinbaseUpdateAtMs = Date.now();
                // Push Coinbase feed to dashboard immediately (so you can see data even before trades).
                if (this.state) {
                    this.state.lastCoinbasePriceDollars = data.price;
                    this.state.lastCoinbaseUpdateAtMs = this.lastCoinbaseUpdateAtMs;
                    this.state.coinbaseDirection = data.trend;
                    this.state.updatedAt = Date.now();
                    if (this.state.lastKalshiUnderlyingPriceDollars !== null) {
                        const diff = data.price - this.state.lastKalshiUnderlyingPriceDollars;
                        this.state.coinbaseMinusUnderlyingDollars = diff;
                        this.state.coinbaseMinusUnderlyingPct =
                            this.state.lastKalshiUnderlyingPriceDollars
                                ? (diff / this.state.lastKalshiUnderlyingPriceDollars) * 100
                                : null;
                        this.state.coinbaseMinusUnderlyingSign =
                            diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'zero';
                    }
                }
                // Evaluate immediately on every Coinbase tick using the latest cached Kalshi market.
                if (this.latestMarket) {
                    // Warn if Kalshi underlying price is stale (>30s without a WS tick).
                    const underlyingAgeMs = this.lastKalshiUnderlyingUpdateAtMs
                        ? Date.now() - this.lastKalshiUnderlyingUpdateAtMs
                        : null;
                    if (underlyingAgeMs !== null && underlyingAgeMs > 30_000) {
                        logger_js_1.default.warn('Kalshi underlying price is stale — WS may not be pushing ticks', {
                            staleSec: (underlyingAgeMs / 1000).toFixed(0),
                            lastKnownUnderlying: this.lastKalshiUnderlyingPriceDollars,
                        });
                    }
                    void evaluateWithMarket(data, this.latestMarket);
                }
            });
            this.coinbaseClient.connect();
            // Auto-discover the current open market before connecting WS.
            await this.initializeMarketTicker();
            // Seed latestMarket from REST before connecting WS.
            // The WS ticker channel may not send expiration_value on every tick (only on snapshot/lifecycle).
            // Without a seed, strategy.evaluate() returns hold('Kalshi expiration_value unavailable') forever.
            try {
                this.latestMarket = await this.kalshiClient.getMarket(this.currentMarketTicker);
                logger_js_1.default.info('Seeded Kalshi market data from REST', {
                    ticker: this.currentMarketTicker,
                    expiration_value_dollars: this.latestMarket.expiration_value_dollars,
                    yes_bid: this.latestMarket.yes_bid,
                    yes_ask: this.latestMarket.yes_ask,
                });
            }
            catch (err) {
                logger_js_1.default.warn('Could not seed market data from REST — WS will populate on first tick', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            // Start the Kalshi WebSocket feed — real-time push, no REST polling, no rate limit usage.
            this.startKalshiWsFeed();
        }
        else {
            // Demo mode: synthetic Coinbase price series so the UI never stays blank.
            this.demoCoinbaseStartAtMs = Date.now();
            const strike = this.demoTargetDollars ?? config_js_1.config.strategy.referencePriceDollars;
            const amplitude = strike * 0.003; // +/- 0.3%
            this.demoCoinbasePriceDollars = strike;
            this.demoCoinbaseHistory = [];
            const freq = (2 * Math.PI) / 20_000; // ~20s period
            const tickMs = config_js_1.config.strategy.pollIntervalMs;
            // Ensure we have something immediately.
            const now = Date.now();
            this.latestCoinbaseData = {
                price: strike,
                priceChangePct: 0,
                trend: 'flat',
                history: [],
            };
            this.lastCoinbaseUpdateAtMs = now;
            if (this.state) {
                this.state.lastCoinbasePriceDollars = strike;
                this.state.lastCoinbaseUpdateAtMs = now;
                this.state.coinbaseDirection = 'flat';
                this.state.updatedAt = now;
            }
            this.demoCoinbaseTimer = setInterval(() => {
                if (!this.state)
                    return;
                const t = Date.now() - this.demoCoinbaseStartAtMs;
                const price = strike + amplitude * Math.sin(t * freq);
                this.demoCoinbasePriceDollars = price;
                const ts = Date.now();
                this.demoCoinbaseHistory.push({ price, timestamp: ts });
                const cutoff = ts - config_js_1.config.strategy.trendWindowSeconds * 1000;
                this.demoCoinbaseHistory = this.demoCoinbaseHistory.filter((p) => p.timestamp >= cutoff);
                const oldest = this.demoCoinbaseHistory[0];
                let priceChangePct = 0;
                if (oldest && oldest.price !== 0) {
                    priceChangePct = ((price - oldest.price) / oldest.price) * 100;
                }
                const thr = config_js_1.config.strategy.priceMoveThresholdPct;
                const trend = priceChangePct > thr ? 'up' : priceChangePct < -thr ? 'down' : 'flat';
                this.latestCoinbaseData = {
                    price,
                    priceChangePct,
                    trend,
                    history: [...this.demoCoinbaseHistory],
                };
                this.lastCoinbaseUpdateAtMs = ts;
                this.state.lastCoinbasePriceDollars = price;
                this.state.lastCoinbaseUpdateAtMs = ts;
                this.state.coinbaseDirection = trend;
                // Keep updatedAt fresh even before trades.
                this.state.updatedAt = ts;
            }, tickMs);
        }
        const logBalanceEvery60s = async () => {
            if (!this.kalshiClient || !this.strategy || !this.state)
                return;
            try {
                const balanceCents = mode === 'demo' ? this.strategy.getDemoCashCents() : await this.kalshiClient.getBalance();
                logger_js_1.default.info('Portfolio balance', {
                    balanceDollars: (balanceCents / 100).toFixed(2),
                    balanceCents,
                });
            }
            catch (err) {
                logger_js_1.default.warn('Could not fetch balance', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        };
        void logBalanceEvery60s();
        this.balanceLogTimer = setInterval(() => void logBalanceEvery60s(), 60_000);
        // Demo mode: evaluate on a timer using the synthetic market (no real Kalshi fetch needed).
        if (mode === 'demo') {
            this.pollTimer = setInterval(async () => {
                const coinbaseData = this.latestCoinbaseData;
                if (!coinbaseData)
                    return;
                const market = this.buildDemoMarket(this.currentMarketTicker, coinbaseData.price);
                await evaluateWithMarket(coinbaseData, market);
            }, config_js_1.config.strategy.pollIntervalMs);
        }
        logger_js_1.default.info('Bot runner running');
    }
    maybeRecordTrade(result) {
        if (!result.tradeKind || !result.side || !result.count || result.limitPriceCents === undefined)
            return false;
        if (!result.orderAction)
            return false;
        const entry = {
            timestamp: Date.now(),
            tradeKind: result.tradeKind,
            orderAction: result.orderAction,
            side: result.side,
            count: result.count,
            limitPriceCents: result.limitPriceCents,
            orderId: result.orderId,
        };
        this.trades.push(entry);
        // Keep history bounded so dashboard stays fast.
        if (this.trades.length > 200)
            this.trades.shift();
        return true;
    }
    async updateDashboardState(mode) {
        if (!this.kalshiClient || !this.strategy || !this.state)
            return;
        const balancePromise = mode === 'demo' ? Promise.resolve(this.strategy.getDemoCashCents()) : this.kalshiClient.getBalance();
        const positionsPromise = mode === 'demo'
            ? Promise.resolve(this.strategy.getDemoPositionContracts())
            : (async () => {
                const positions = await this.kalshiClient.getPositions();
                return positions.find((p) => p.ticker === this.currentMarketTicker)?.position ?? 0;
            })();
        const openOrdersCountPromise = mode === 'demo'
            ? Promise.resolve(this.strategy.getOpenOrderIds().length)
            : (async () => {
                const openOrders = await this.kalshiClient.getOpenOrders(this.currentMarketTicker);
                return openOrders.length;
            })();
        const [currentBalanceCents, positionContracts, openOrdersCount] = await Promise.all([
            balancePromise,
            positionsPromise,
            openOrdersCountPromise,
        ]);
        const positionSide = positionContracts > 0 ? 'long' : positionContracts < 0 ? 'short' : 'flat';
        this.state.currentBalanceCents = currentBalanceCents;
        this.state.pnlCents = currentBalanceCents - this.state.startBalanceCents;
        this.state.positionContracts = positionContracts;
        this.state.positionSide = positionSide;
        this.state.openOrdersCount = openOrdersCount;
        this.state.lastCrossDirection = this.strategy.getLastCrossDirection();
        this.state.lastCrossAtMs = this.strategy.getLastCrossAtMs();
        this.state.armedTpExitLimitCents = this.strategy.getArmedTpExitLimitCents();
        this.state.armedTpExitSide = this.strategy.getArmedTpExitSide();
        this.state.coinbaseDirection = this.strategy.getLastCoinbaseDirection();
        this.state.lastCoinbasePriceDollars = this.strategy.getLastObservedCoinbasePriceDollars();
        this.state.lastKalshiUnderlyingPriceDollars =
            this.strategy.getLastObservedKalshiUnderlyingPriceDollars();
        this.state.lastTargetPriceDollars = this.strategy.getLastTargetPriceDollars();
        this.state.lastCoinbaseUpdateAtMs = this.lastCoinbaseUpdateAtMs;
        this.state.lastKalshiUnderlyingUpdateAtMs = this.lastKalshiUnderlyingUpdateAtMs;
        this.state.lastEvalAtMs = this.lastEvalAtMs;
        const cb = this.state.lastCoinbasePriceDollars;
        const ul = this.state.lastKalshiUnderlyingPriceDollars;
        if (cb === null || cb === undefined || ul === null || ul === undefined || ul === 0) {
            this.state.coinbaseMinusUnderlyingDollars = null;
            this.state.coinbaseMinusUnderlyingPct = null;
            this.state.coinbaseMinusUnderlyingSign = null;
        }
        else {
            const diff = cb - ul;
            this.state.coinbaseMinusUnderlyingDollars = diff;
            this.state.coinbaseMinusUnderlyingPct = (diff / ul) * 100;
            if (diff > 0)
                this.state.coinbaseMinusUnderlyingSign = 'positive';
            else if (diff < 0)
                this.state.coinbaseMinusUnderlyingSign = 'negative';
            else
                this.state.coinbaseMinusUnderlyingSign = 'zero';
        }
        this.state.currentTradeSide = this.strategy.getCurrentTradeSide();
        this.state.currentTradeEntryLimitCents = this.strategy.getCurrentTradeEntryLimitCents();
        this.state.currentTradeCount = this.strategy.getCurrentTradeCount();
        this.state.currentTradePnLCents = this.strategy.getCurrentTradePnLCents();
        this.state.currentTradePnLMode = this.strategy.getCurrentTradePnLMode();
        this.state.updatedAt = Date.now();
    }
    /**
     * At startup, query Kalshi for currently open markets in the configured series and
     * switch to the earliest-closing one. This means KALSHI_MARKET_TICKER only needs to
     * contain the series prefix (e.g. "kxbtc15m") — the exact contract is auto-discovered.
     */
    async initializeMarketTicker() {
        if (!this.kalshiClient)
            return;
        const prefix = this.currentMarketTicker.split('-')[0];
        const seriesTicker = prefix.toUpperCase();
        try {
            const openMarkets = await this.kalshiClient.getMarkets({
                seriesTicker,
                status: 'open',
                limit: 100,
            });
            const now = Date.now();
            const best = openMarkets
                .filter((m) => m.ticker && m.close_time && new Date(m.close_time).getTime() >= now)
                .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];
            if (best) {
                if (best.ticker !== this.currentMarketTicker) {
                    logger_js_1.default.info('Auto-discovered current Kalshi market at startup', {
                        configured: this.currentMarketTicker,
                        active: best.ticker,
                        closeTime: best.close_time,
                    });
                    this.currentMarketTicker = best.ticker;
                    if (this.state)
                        this.state.marketTicker = best.ticker;
                }
                else {
                    logger_js_1.default.info('Configured Kalshi market ticker is current', { ticker: best.ticker });
                }
            }
            else {
                logger_js_1.default.warn('No open markets found for series at startup — will retry in fetch loop', {
                    seriesTicker,
                });
            }
        }
        catch (err) {
            logger_js_1.default.warn('Could not auto-discover market ticker at startup — using configured value', {
                ticker: this.currentMarketTicker,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    /** Start real-time Kalshi market data via WebSocket (replaces REST polling loop). */
    startKalshiWsFeed() {
        if (!this.kalshiClient)
            return;
        this.kalshiWsClient = new wsClient_js_1.KalshiWsClient(this.currentMarketTicker, this.kalshiClient?.privateKey ?? null, this.kalshiClient?.apiKeyId ?? '', this.latestMarket ?? undefined);
        this.kalshiWsClient.on('market', (market) => {
            this.latestMarket = market;
            // Auto-rotate if the market just closed and we have no position.
            const closeMs = new Date(market.close_time || 0).getTime();
            const shouldRotate = market.status !== 'open' || (closeMs > 0 && closeMs - Date.now() <= 10_000);
            const isPending = (this.strategy?.getPendingPhase() ?? null) !== null;
            if (shouldRotate && !isPending) {
                void this.tryRotateMarketTicker();
            }
        });
        this.kalshiWsClient.on('connected', () => {
            logger_js_1.default.info('Kalshi WebSocket feed connected — real-time market data active');
        });
        this.kalshiWsClient.on('disconnected', (code, reason) => {
            logger_js_1.default.warn('Kalshi WebSocket disconnected — reconnecting automatically', { code, reason });
        });
        this.kalshiWsClient.on('error', (err) => {
            logger_js_1.default.error('Kalshi WebSocket error', { error: err.message });
        });
        this.kalshiWsClient.connect();
    }
    // BUG-I2: Debounce rotation checks — runs on every WS tick without this guard,
    // which fires 100+ concurrent REST calls racing on this.currentMarketTicker.
    lastRotationCheckMs = 0;
    /** Auto-rotate to the next open market (called when current market is near/past close). */
    async tryRotateMarketTicker() {
        if (!this.kalshiClient)
            return;
        // Debounce: skip if we checked less than 10s ago.
        if (Date.now() - this.lastRotationCheckMs < 10_000)
            return;
        this.lastRotationCheckMs = Date.now();
        try {
            const positions = await this.kalshiClient.getPositions();
            const positionContracts = positions.find((p) => p.ticker === this.currentMarketTicker)?.position ?? 0;
            if (positionContracts !== 0)
                return; // Don't rotate while holding a position.
            const prefix = this.currentMarketTicker.split('-')[0];
            const seriesTicker = prefix.toUpperCase();
            const openMarkets = await this.kalshiClient.getMarkets({
                seriesTicker,
                status: 'open',
                limit: 100,
            });
            const now = Date.now();
            const next = openMarkets
                .filter((m) => m.ticker && m.close_time && new Date(m.close_time).getTime() >= now)
                .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];
            if (next && next.ticker !== this.currentMarketTicker) {
                logger_js_1.default.info('Auto-rotating market ticker', {
                    from: this.currentMarketTicker,
                    to: next.ticker,
                    closeTime: next.close_time,
                });
                this.currentMarketTicker = next.ticker;
                if (this.state)
                    this.state.marketTicker = next.ticker;
                // Tell WS client to resubscribe to the new ticker.
                this.kalshiWsClient?.setMarketTicker(next.ticker);
            }
        }
        catch {
            // Best-effort; ignore rotation failures.
        }
    }
    async stop() {
        if (!this.coinbaseClient || !this.kalshiClient || !this.strategy)
            return;
        logger_js_1.default.info('Stopping bot runner');
        this.kalshiFetchLoopActive = false;
        this.kalshiWsClient?.disconnect();
        this.kalshiWsClient = null;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.balanceLogTimer) {
            clearInterval(this.balanceLogTimer);
            this.balanceLogTimer = null;
        }
        if (this.demoCoinbaseTimer) {
            clearInterval(this.demoCoinbaseTimer);
            this.demoCoinbaseTimer = null;
        }
        this.coinbaseClient.disconnect();
        // Cancel open orders if in live mode.
        if (!config_js_1.config.dryRun) {
            await this.strategy.cancelAllOpenOrders();
        }
        else {
            const openIds = this.strategy.getOpenOrderIds();
            if (openIds.length > 0) {
                logger_js_1.default.info('[DRY RUN] Would cancel open orders on stop', { orderIds: openIds });
            }
        }
        this.state = null;
        this.trades = [];
        this.latestMarket = null;
        this.coinbaseClient = null;
        this.kalshiClient = null;
        this.strategy = null;
        this.demoTargetDollars = null;
    }
}
exports.BotRunner = BotRunner;
//# sourceMappingURL=botRunner.js.map