"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArbStrategy = void 0;
const logger_js_1 = __importDefault(require("../utils/logger.js"));
const config_js_1 = require("../config.js");
const marketNormalize_js_1 = require("../kalshi/marketNormalize.js");
class ArbStrategy {
    kalshiClient;
    lastOrderTime = 0;
    openOrderIds = [];
    lastMarketTicker = null;
    prevCoinbasePrice = null;
    peakCoinbase = null;
    troughCoinbase = null;
    // Latest observed prices (useful for dashboards/diagnostics).
    lastCoinbasePriceDollars = null;
    lastKalshiUnderlyingPriceDollars = null;
    lastTargetPriceDollars = null;
    lastCrossDirection = null;
    lastCrossAtMs = null;
    // Exit TP that has been armed by the most recent reversal cross.
    armedTpExitLimitCents = null;
    armedTpExitSide = null;
    // Current trade accounting (for dashboard “P/L of the trade”).
    // We approximate entry fills at the entry order limit price.
    currentTradeSide = null;
    currentTradeEntryLimitCents = null;
    currentTradeCount = null;
    currentTradePnLCents = null;
    currentTradePnLMode = null;
    // Debug: current tick comparison and direction.
    lastCoinbaseDirection = null;
    lastCoinbaseMinusUnderlyingDollars = null;
    // Last evaluated Coinbase price — used in placeEntryOrder for edge calculation.
    lastEvaluatedCoinbasePrice = null;
    // Momentum EMAs (tick-based, not time-based — each Coinbase price update is one tick).
    // alpha5 ≈ fast (tracks last ~5 ticks), alpha20 ≈ slow (tracks last ~20 ticks).
    ema5s = null;
    ema20s = null;
    prevEma5s = null; // EMA5 from the previous tick — used for cross detection
    prevEma20s = null; // EMA20 from the previous tick — used for cross detection
    static EMA5_ALPHA = 2 / (5 + 1); // 0.333
    static EMA20_ALPHA = 2 / (20 + 1); // 0.095
    // Regime filter: track strike crossings within a rolling window.
    crossTimestamps = [];
    static REGIME_WINDOW_MS = 3 * 60 * 1000; // 3 minutes (tighter window = less false-positive pauses)
    static REGIME_MAX_CROSSES = 12; // raised from 8 — was triggering on normal BTC volatility
    regimePausedUntilMs = 0;
    // Sequential exit-then-entry state machine:
    // - phase='exit' waits for the exit order to fully flatten position to 0.
    // - phase='entry' waits for the entry order to reach the target side.
    pendingSide = null;
    pendingPhase = null;
    pendingExitOrderId = null;
    pendingSinceMs = null;
    /** Live: after EXIT_LIMIT_GRACE_MS, limit exit was canceled and we are flattening with market sells. */
    exitEscalatedToMarket = false;
    // Used only in DRY_RUN mode so we can still simulate sequential state.
    simulatedPositionContracts = 0;
    // Position cache: avoid calling getPositions() on every Coinbase tick (reduces dropped ticks).
    cachedPositionContracts = 0;
    lastPositionFetchMs = 0;
    static POSITION_CACHE_TTL_MS = 500;
    /** When API omits a BTC-scale Kalshi index, EMA-smooth Coinbase to approximate lagged underlying. */
    syntheticKalshiUnderlyingDollars = null;
    warnedExpirationFallbackForTicker = null;
    // Demo-mode account tracking (only meaningful when `config.dryRun` is true).
    demoStartingCashCents = config_js_1.config.paperBalanceCents;
    demoCashCents = config_js_1.config.paperBalanceCents;
    // When true, close any open position as soon as bid >= entry price (breakeven or better).
    closeAtBreakevenEnabled = false;
    constructor(kalshiClient) {
        this.kalshiClient = kalshiClient;
    }
    setCloseAtBreakeven(enabled) {
        this.closeAtBreakevenEnabled = enabled;
        logger_js_1.default.info('Close-at-breakeven', { enabled });
    }
    isCloseAtBreakevenEnabled() {
        return this.closeAtBreakevenEnabled;
    }
    getDemoStartingCashCents() {
        return this.demoStartingCashCents;
    }
    getDemoCashCents() {
        return this.demoCashCents;
    }
    getDemoPositionContracts() {
        return this.simulatedPositionContracts;
    }
    getLastCrossDirection() {
        return this.lastCrossDirection;
    }
    getLastCrossAtMs() {
        return this.lastCrossAtMs;
    }
    getArmedTpExitLimitCents() {
        return this.armedTpExitLimitCents;
    }
    getArmedTpExitSide() {
        return this.armedTpExitSide;
    }
    getLastCoinbaseDirection() {
        return this.lastCoinbaseDirection;
    }
    getLastCoinbaseMinusUnderlyingDollars() {
        return this.lastCoinbaseMinusUnderlyingDollars;
    }
    getLastObservedCoinbasePriceDollars() {
        return this.lastCoinbasePriceDollars;
    }
    getLastObservedKalshiUnderlyingPriceDollars() {
        return this.lastKalshiUnderlyingPriceDollars;
    }
    getLastTargetPriceDollars() {
        return this.lastTargetPriceDollars;
    }
    getPendingPhase() {
        return this.pendingPhase;
    }
    getPendingSide() {
        return this.pendingSide;
    }
    getCurrentTradeSide() {
        return this.currentTradeSide;
    }
    getCurrentTradeEntryLimitCents() {
        return this.currentTradeEntryLimitCents;
    }
    getCurrentTradeCount() {
        return this.currentTradeCount;
    }
    getCurrentTradePnLCents() {
        return this.currentTradePnLCents;
    }
    getCurrentTradePnLMode() {
        return this.currentTradePnLMode;
    }
    /**
     * Computes the theoretical YES probability from Coinbase price movement
     * using a sigmoid-like linear approximation.
     *
     * Formula: theoretical_yes_prob = 50 + (priceChangePct / 0.1) * 15
     * Clamped to [20, 80].
     *
     * Examples:
     *   priceChangePct = +0.10% → 50 + (0.10 / 0.10) * 15 = 65
     *   priceChangePct = -0.10% → 50 + (-0.10 / 0.10) * 15 = 35
     *   priceChangePct = +0.20% → clamped to 80
     *   priceChangePct = 0.00%  → 50
     */
    computeTheoreticalYesProb(priceChangePct) {
        const raw = 50 + (priceChangePct / 0.1) * 15;
        return Math.max(20, Math.min(80, raw));
    }
    /**
     * Computes the Kalshi implied YES probability from mid-market price.
     * mid = (yes_bid + yes_ask) / 2
     */
    computeImpliedYesProb(market) {
        if (market.yes_bid === 0 && market.yes_ask === 0)
            return 50;
        return (market.yes_bid + market.yes_ask) / 2;
    }
    /**
     * Returns the number of seconds until the market closes.
     */
    secondsUntilClose(market) {
        const closeMs = new Date(market.close_time).getTime();
        const nowMs = Date.now();
        return Math.max(0, (closeMs - nowMs) / 1000);
    }
    /**
     * Determines the position size in contracts.
     * min(MAX_POSITION_SIZE, floor(balance * balanceFractionPerTrade / askPriceInDollars))
     */
    computePositionSize(balanceCents, askPriceCents, edgeCents) {
        // Guard: degenerate ask price — division by zero would produce Infinity.
        if (askPriceCents <= 0)
            return 0;
        // Dynamic sizing: scale position by edge magnitude relative to a reference edge of 10c.
        // Low edge (7c) → 70% of base size. High edge (20c) → 200% (capped by maxPositionSize).
        const baseFraction = config_js_1.config.strategy.balanceFractionPerTrade;
        const edgeMultiplier = edgeCents !== undefined
            ? Math.min(2.0, Math.max(0.5, edgeCents / 10))
            : 1.0;
        const fractionBalance = balanceCents * baseFraction * edgeMultiplier;
        const maxFromBalance = Math.floor(fractionBalance / askPriceCents);
        return Math.max(1, Math.min(config_js_1.config.strategy.maxPositionSize, maxFromBalance));
    }
    /**
     * Guard against empty books for a specific side.
     * Only checks the side we intend to enter — avoids blocking valid YES entries
     * when NO contracts are worthless (deep ITM market) and vice versa.
     * If no side is specified, falls back to blocking if EITHER side is unavailable
     * (conservative — used for exits where we need full book depth).
     */
    isOrderbookUnavailable(market, side) {
        if (side === 'yes')
            return market.yes_bid <= 0 && market.yes_ask <= 0;
        if (side === 'no')
            return market.no_bid <= 0 && market.no_ask <= 0;
        // No side specified: block if either side is empty (conservative).
        const yesUnavailable = market.yes_bid <= 0 && market.yes_ask <= 0;
        const noUnavailable = market.no_bid <= 0 && market.no_ask <= 0;
        return yesUnavailable || noUnavailable;
    }
    /**
     * Refreshes the open order list by querying Kalshi and reconciling with
     * our tracked list.
     */
    async refreshOpenOrders(ticker) {
        try {
            const openOrders = await this.kalshiClient.getOpenOrders(ticker);
            this.openOrderIds = openOrders.map((o) => o.order_id);
        }
        catch (err) {
            logger_js_1.default.warn('Could not refresh open orders', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    /**
     * Fill missing `expiration_value` / BTC index from API quirks: empty expiration before settlement,
     * `last_price_dollars` as YES contract price (0–1) instead of spot. Mutates `market`.
     */
    applyMarketFieldEnrichment(market, coinbasePrice) {
        const exp = market.expiration_value_dollars;
        if (exp === undefined || Number.isNaN(exp) || exp <= 0) {
            market.expiration_value_dollars = config_js_1.config.strategy.referencePriceDollars;
            if (this.warnedExpirationFallbackForTicker !== market.ticker) {
                this.warnedExpirationFallbackForTicker = market.ticker;
                logger_js_1.default.warn('Kalshi strike/expiration_value still unavailable after API normalization — using KALSHI_REFERENCE_PRICE_DOLLARS', { ticker: market.ticker, referencePriceDollars: config_js_1.config.strategy.referencePriceDollars });
            }
        }
        const apiUnderlying = market.last_price_dollars;
        if (apiUnderlying !== undefined && (0, marketNormalize_js_1.isPlausibleBtcUsd)(apiUnderlying)) {
            this.syntheticKalshiUnderlyingDollars = apiUnderlying;
            return;
        }
        const alpha = config_js_1.config.strategy.syntheticUnderlyingAlpha;
        const prev = this.syntheticKalshiUnderlyingDollars ?? coinbasePrice;
        const next = prev + alpha * (coinbasePrice - prev);
        this.syntheticKalshiUnderlyingDollars = next;
        market.last_price_dollars = next;
        if (apiUnderlying !== undefined && apiUnderlying <= 1.5) {
            logger_js_1.default.debug('Kalshi last_price_dollars is contract-scale; using synthetic lagged BTC index', {
                contractLastUsd: apiUnderlying,
                syntheticBtcUsd: next,
            });
        }
    }
    /**
     * Main evaluation method. Called on every poll cycle.
     * Determines whether to place a YES or NO order based on the edge between
     * Coinbase-implied probability and Kalshi market probability.
     */
    async evaluate(coinbaseData, market) {
        // If we rotated to a different market ticker, reset internal cross/TP tracking
        // so we don't form crosses using stale underlyings.
        if (this.lastMarketTicker !== market.ticker) {
            this.lastMarketTicker = market.ticker;
            this.prevCoinbasePrice = null;
            this.peakCoinbase = null;
            this.troughCoinbase = null;
            this.lastCrossDirection = null;
            this.lastCrossAtMs = null;
            this.armedTpExitLimitCents = null;
            this.armedTpExitSide = null;
            this.pendingPhase = null;
            this.pendingSide = null;
            this.pendingExitOrderId = null;
            this.pendingSinceMs = null;
            this.exitEscalatedToMarket = false;
            this.syntheticKalshiUnderlyingDollars = null;
            this.warnedExpirationFallbackForTicker = null;
            // Reset EMAs and regime filter for the new market.
            this.ema5s = null;
            this.ema20s = null;
            this.prevEma5s = null;
            this.prevEma20s = null;
            this.crossTimestamps = [];
            this.regimePausedUntilMs = 0;
        }
        const coinbasePrice = coinbaseData.price;
        this.applyMarketFieldEnrichment(market, coinbasePrice);
        // Cross detection compares Coinbase BTC spot vs the fixed strike price (expiration_value_dollars).
        // We do NOT use last_price_dollars (which is either a 0–1 contract price or a synthetic EMA)
        // because that caused crosses to fire on any Coinbase reversal rather than real BTC/strike crossings.
        const targetPriceDollars = market.expiration_value_dollars;
        if (targetPriceDollars === undefined || Number.isNaN(targetPriceDollars)) {
            return this.hold('Kalshi expiration_value/target BTC price unavailable');
        }
        // For cross detection and all diff calculations, the "underlying" is the fixed strike price.
        const kalshiUnderlyingPriceDollars = targetPriceDollars;
        // Save observed prices for the dashboard.
        this.lastCoinbasePriceDollars = coinbasePrice;
        this.lastKalshiUnderlyingPriceDollars = kalshiUnderlyingPriceDollars;
        this.lastTargetPriceDollars = targetPriceDollars;
        logger_js_1.default.debug('Strategy evaluation', {
            btcPrice: coinbaseData.price.toFixed(2),
            coinbasePriceChangePct: coinbaseData.priceChangePct.toFixed(4),
            trend: coinbaseData.trend,
            referencePrice: targetPriceDollars,
            kalshiUnderlyingPriceDollars: kalshiUnderlyingPriceDollars.toFixed(2),
            pendingPhase: this.pendingPhase,
            pendingSide: this.pendingSide,
        });
        // --- Guard: Market must be open ---
        if (market.status !== 'open') {
            return this.hold(`Market status is ${market.status}`);
        }
        // --- Guard: Must have enough time before expiry ---
        const secsLeft = this.secondsUntilClose(market);
        if (secsLeft < config_js_1.config.strategy.minSecondsBeforeExpiry) {
            return this.hold(`Market closes in ${secsLeft.toFixed(0)}s — too close to expiry`);
        }
        // --- Guard: Must not have too much time remaining (weak signal, uncertain) ---
        if (secsLeft > config_js_1.config.strategy.maxSecondsBeforeExpiry) {
            return this.hold(`Market closes in ${secsLeft.toFixed(0)}s — too far from expiry (max ${config_js_1.config.strategy.maxSecondsBeforeExpiry}s)`);
        }
        // --- Guard: Regime filter — pause trading if BTC is whipsawing around the strike ---
        const now = Date.now();
        if (now < this.regimePausedUntilMs) {
            const pauseSecsLeft = ((this.regimePausedUntilMs - now) / 1000).toFixed(0);
            return this.hold(`Regime pause active — choppy market, resuming in ${pauseSecsLeft}s`);
        }
        // Prune cross timestamps older than the regime window.
        this.crossTimestamps = this.crossTimestamps.filter(t => now - t < ArbStrategy.REGIME_WINDOW_MS);
        // --- Guard: if either YES/NO side has no contracts, do not trade ---
        if (this.isOrderbookUnavailable(market)) {
            return this.hold(`Orderbook unavailable (yes ${market.yes_bid}/${market.yes_ask}, no ${market.no_bid}/${market.no_ask})`);
        }
        const prevPrice = this.prevCoinbasePrice;
        // Always advance the stored previous price so cross detection uses the last tick,
        // even when we return early during pending phases.
        this.prevCoinbasePrice = coinbasePrice;
        // Get current position exposure.
        // Cache the result for POSITION_CACHE_TTL_MS to avoid an async API call on every Coinbase
        // tick — getPositions() takes ~100-300ms and would cause isEvaluating to block every tick.
        let positionContracts = 0;
        if (config_js_1.config.dryRun) {
            positionContracts = this.simulatedPositionContracts;
        }
        else {
            const now = Date.now();
            if (now - this.lastPositionFetchMs >= ArbStrategy.POSITION_CACHE_TTL_MS) {
                const positions = await this.kalshiClient.getPositions();
                this.cachedPositionContracts =
                    positions.find((p) => p.ticker === market.ticker)?.position ?? 0;
                this.lastPositionFetchMs = now;
            }
            positionContracts = this.cachedPositionContracts;
        }
        const isLong = positionContracts > 0;
        const isShort = positionContracts < 0;
        const isFlat = positionContracts === 0;
        // Store for use in placeEntryOrder edge calculation.
        this.lastEvaluatedCoinbasePrice = coinbasePrice;
        // Update momentum EMAs on every tick.
        // Save previous values BEFORE updating so cross detection can compare prev vs current.
        this.prevEma5s = this.ema5s;
        this.prevEma20s = this.ema20s;
        if (this.ema5s === null || this.ema20s === null) {
            this.ema5s = coinbasePrice;
            this.ema20s = coinbasePrice;
        }
        else {
            this.ema5s = this.ema5s + ArbStrategy.EMA5_ALPHA * (coinbasePrice - this.ema5s);
            this.ema20s = this.ema20s + ArbStrategy.EMA20_ALPHA * (coinbasePrice - this.ema20s);
        }
        // Update current-trade unrealized P/L mark-to-market (based on mid prices).
        // This is only meaningful when we have entry info stored.
        if (!isFlat && this.currentTradeEntryLimitCents !== null && this.currentTradeCount !== null) {
            const sideHeld = isLong ? 'yes' : 'no';
            const entryLimit = this.currentTradeEntryLimitCents;
            const count = Math.max(0, this.currentTradeCount);
            const midCents = sideHeld === 'yes' ? (market.yes_bid + market.yes_ask) / 2 : (market.no_bid + market.no_ask) / 2;
            this.currentTradeSide = sideHeld;
            this.currentTradePnLCents = Math.round(count * (midCents - entryLimit));
            this.currentTradePnLMode = 'unrealized';
        }
        else if (isFlat) {
            // If we're flat, we keep whatever realized P/L was computed at the exit fill.
            if (positionContracts === 0) {
                // no-op
            }
        }
        // --- Breakeven close: if enabled, exit whenever bid >= entry price ---
        if (this.closeAtBreakevenEnabled &&
            !isFlat &&
            !this.pendingPhase &&
            this.currentTradeEntryLimitCents !== null) {
            const sideHeld = isLong ? 'yes' : 'no';
            const bid = isLong ? market.yes_bid : market.no_bid;
            if (bid >= this.currentTradeEntryLimitCents) {
                logger_js_1.default.info('Breakeven close triggered', {
                    sideHeld,
                    bid,
                    entryPrice: this.currentTradeEntryLimitCents,
                });
                const count = Math.abs(positionContracts);
                const exitRes = await this.placeMarketExitOrder(market, sideHeld, count);
                if (exitRes.action !== 'hold') {
                    this.pendingSide = isLong ? 'short' : 'long';
                    this.pendingPhase = 'exit';
                    this.pendingSinceMs = Date.now();
                }
                return exitRes;
            }
        }
        // --- Handle pending sequential phases ---
        if (this.pendingPhase && this.pendingSide) {
            // Phase 1: wait for exit fill (flatten to 0).
            if (this.pendingPhase === 'exit') {
                if (positionContracts === 0) {
                    this.exitEscalatedToMarket = false;
                    // Exit complete: now place the entry for the pending side.
                    // Compute realized P/L for the trade we just closed.
                    if (this.currentTradeEntryLimitCents !== null &&
                        this.currentTradeCount !== null &&
                        this.armedTpExitLimitCents !== null &&
                        this.currentTradePnLCents !== null) {
                        const realized = this.currentTradeCount * (this.armedTpExitLimitCents - this.currentTradeEntryLimitCents);
                        this.currentTradePnLCents = Math.round(realized);
                        this.currentTradePnLMode = 'realized';
                    }
                    this.armedTpExitLimitCents = null;
                    this.armedTpExitSide = null;
                    // Spread gate: re-check before re-entry — book may have widened during exit wait.
                    const reEntrySide = this.pendingSide === 'long' ? 'yes' : 'no';
                    const reEntrySpread = reEntrySide === 'yes'
                        ? market.yes_ask - market.yes_bid
                        : market.no_ask - market.no_bid;
                    if (reEntrySpread > 8) {
                        this.pendingPhase = null;
                        this.pendingSide = null;
                        this.pendingExitOrderId = null;
                        this.pendingSinceMs = null;
                        return this.hold(`Spread too wide for re-entry: ${reEntrySpread}¢ > 8¢`);
                    }
                    const entryRes = reEntrySide === 'yes'
                        ? await this.placeEntryOrder(market, 'yes')
                        : await this.placeEntryOrder(market, 'no');
                    if (entryRes.action === 'hold') {
                        // Exit is already filled but entry couldn't be placed; HOLD until next qualifying cross.
                        this.pendingPhase = null;
                        this.pendingSide = null;
                        this.pendingExitOrderId = null;
                        this.pendingSinceMs = null;
                        return entryRes;
                    }
                    this.pendingPhase = 'entry';
                    this.pendingSinceMs = Date.now();
                    this.pendingExitOrderId = null;
                    return {
                        ...entryRes,
                        pendingPhase: this.pendingPhase,
                        pendingSide: this.pendingSide,
                        coinbasePrice,
                        referencePriceDollars: targetPriceDollars,
                        kalshiUnderlyingPriceDollars,
                    };
                }
                if (this.pendingSinceMs !== null) {
                    const elapsed = Date.now() - this.pendingSinceMs;
                    if (elapsed > config_js_1.config.strategy.exitWaitTimeoutMs) {
                        // Do not abandon a live open position; force/continue emergency flatten.
                        if (!config_js_1.config.dryRun && positionContracts !== 0) {
                            if (this.pendingExitOrderId) {
                                try {
                                    await this.kalshiClient.cancelOrder(this.pendingExitOrderId);
                                }
                                catch (err) {
                                    logger_js_1.default.warn('Failed to cancel pending exit order on timeout', {
                                        orderId: this.pendingExitOrderId,
                                        error: err instanceof Error ? err.message : String(err),
                                    });
                                }
                            }
                            this.pendingExitOrderId = null;
                            await this.cancelTrackedOpenOrdersForFlatten();
                            this.exitEscalatedToMarket = true;
                            // Force-refresh position so we never sell more than we actually hold.
                            const freshContracts = await this.fetchFreshPositionContracts(market.ticker);
                            if (freshContracts === 0) {
                                this.pendingPhase = null;
                                this.pendingSide = null;
                                this.pendingSinceMs = null;
                                this.exitEscalatedToMarket = false;
                                return this.hold('Emergency flatten: position already flat');
                            }
                            const exitSide = freshContracts > 0 ? 'yes' : 'no';
                            const flattenCount = Math.abs(freshContracts);
                            const marketRes = await this.placeMarketExitOrder(market, exitSide, flattenCount);
                            if (marketRes.action !== 'hold') {
                                return {
                                    ...marketRes,
                                    pendingPhase: this.pendingPhase,
                                    pendingSide: this.pendingSide,
                                    coinbasePrice,
                                    referencePriceDollars: targetPriceDollars,
                                    kalshiUnderlyingPriceDollars,
                                };
                            }
                            return this.hold(`Emergency flatten retry after pending-exit timeout (${(elapsed / 1000).toFixed(0)}s): ${marketRes.reason}`);
                        }
                        this.pendingPhase = null;
                        this.pendingSide = null;
                        this.pendingExitOrderId = null;
                        this.pendingSinceMs = null;
                        this.exitEscalatedToMarket = false;
                        this.armedTpExitLimitCents = null;
                        this.armedTpExitSide = null;
                        return this.hold(`Pending exit timed out after ${(elapsed / 1000).toFixed(0)}s; flat`);
                    }
                    // Live: after grace on limit exit, flatten remainder with market sells until flat.
                    if (!config_js_1.config.dryRun &&
                        positionContracts !== 0 &&
                        elapsed >= config_js_1.config.strategy.exitLimitGraceMs) {
                        if (!this.exitEscalatedToMarket) {
                            if (this.pendingExitOrderId) {
                                try {
                                    await this.kalshiClient.cancelOrder(this.pendingExitOrderId);
                                }
                                catch (err) {
                                    logger_js_1.default.warn('Failed to cancel pending exit limit before market flatten', {
                                        orderId: this.pendingExitOrderId,
                                        error: err instanceof Error ? err.message : String(err),
                                    });
                                }
                            }
                            this.pendingExitOrderId = null;
                            await this.cancelTrackedOpenOrdersForFlatten();
                            this.exitEscalatedToMarket = true;
                        }
                        // Force-refresh position so we never sell more contracts than we actually hold.
                        const freshContracts = await this.fetchFreshPositionContracts(market.ticker);
                        if (freshContracts === 0) {
                            this.pendingPhase = null;
                            this.pendingSide = null;
                            this.pendingSinceMs = null;
                            this.exitEscalatedToMarket = false;
                            return this.hold('Grace-period flatten: position already flat');
                        }
                        const exitSide = freshContracts > 0 ? 'yes' : 'no';
                        const flattenCount = Math.abs(freshContracts);
                        const marketRes = await this.placeMarketExitOrder(market, exitSide, flattenCount);
                        if (marketRes.action !== 'hold') {
                            return {
                                ...marketRes,
                                pendingPhase: this.pendingPhase,
                                pendingSide: this.pendingSide,
                                coinbasePrice,
                                referencePriceDollars: targetPriceDollars,
                                kalshiUnderlyingPriceDollars,
                            };
                        }
                        return marketRes;
                    }
                }
                return this.hold(`Waiting for exit fill: position=${positionContracts} pendingSide=${this.pendingSide}`);
            }
            // Phase 2: wait for entry fill (move to the target side).
            if (this.pendingPhase === 'entry') {
                const targetLong = this.pendingSide === 'long';
                const reached = (targetLong && positionContracts > 0) || (!targetLong && positionContracts < 0);
                if (reached) {
                    // Reset extremum tracking for the new leg.
                    this.pendingPhase = null;
                    this.pendingSide = null;
                    this.pendingExitOrderId = null;
                    this.pendingSinceMs = null;
                    if (targetLong) {
                        this.peakCoinbase = coinbasePrice;
                        this.troughCoinbase = null;
                    }
                    else {
                        this.troughCoinbase = coinbasePrice;
                        this.peakCoinbase = null;
                    }
                    return this.hold('Entry filled; TP tracking resumed');
                }
                // Safety timeout: if entry never fills, release the state machine so new crosses
                // can be traded on the next cycle instead of hanging forever.
                if (this.pendingSinceMs !== null) {
                    const elapsed = Date.now() - this.pendingSinceMs;
                    if (elapsed > config_js_1.config.strategy.exitWaitTimeoutMs) {
                        logger_js_1.default.warn('Pending entry timed out — releasing state machine', {
                            elapsed: (elapsed / 1000).toFixed(0),
                            pendingSide: this.pendingSide,
                            positionContracts,
                        });
                        this.pendingPhase = null;
                        this.pendingSide = null;
                        this.pendingExitOrderId = null;
                        this.pendingSinceMs = null;
                        return this.hold(`Pending entry timed out after ${(elapsed / 1000).toFixed(0)}s`);
                    }
                }
                return this.hold(`Waiting for entry fill: position=${positionContracts} pendingSide=${this.pendingSide}`);
            }
        }
        // --- TP / SL / TTE exits: check before cross detection ---
        const tpslExit = await this.checkProfitAndLossExits(market, coinbasePrice, positionContracts, targetPriceDollars, secsLeft);
        if (tpslExit)
            return tpslExit;
        // --- Need a previous tick to detect EMA crossovers ---
        if (prevPrice === null || this.prevEma5s === null || this.prevEma20s === null) {
            if (isLong) {
                this.peakCoinbase = coinbasePrice;
            }
            else if (isShort) {
                this.troughCoinbase = coinbasePrice;
            }
            return this.hold('Waiting for EMA warmup (need 2+ ticks)');
        }
        const rising = coinbasePrice > prevPrice;
        const falling = coinbasePrice < prevPrice;
        // -----------------------------------------------------------------------
        // SIGNAL: EMA5 / EMA20 crossover on Coinbase price.
        //
        // Strategy: Coinbase leads Kalshi by a small latency (~1-5 seconds).
        // When Coinbase flips from downtrend to uptrend (EMA5 crosses above EMA20),
        // Kalshi contracts haven't repriced yet — YES contracts are cheap. Buy YES.
        // Reverse for downtrend flip → buy NO.
        //
        // crossUp  = EMA5 was below EMA20 last tick, now at or above → bullish flip
        // crossDown = EMA5 was above EMA20 last tick, now at or below → bearish flip
        // -----------------------------------------------------------------------
        const crossUp = this.prevEma5s < this.prevEma20s && this.ema5s >= this.ema20s;
        const crossDown = this.prevEma5s > this.prevEma20s && this.ema5s <= this.ema20s;
        // Dashboard: show coinbase vs kalshi underlying diff (informational only, not used for signal)
        const currDiff = coinbasePrice - kalshiUnderlyingPriceDollars;
        this.lastCoinbaseMinusUnderlyingDollars = currDiff;
        this.lastCoinbaseDirection = rising ? 'up' : falling ? 'down' : 'flat';
        logger_js_1.default.debug('EMA cross check', {
            ema5s: this.ema5s.toFixed(2),
            ema20s: this.ema20s.toFixed(2),
            prevEma5s: this.prevEma5s.toFixed(2),
            prevEma20s: this.prevEma20s.toFixed(2),
            crossUp,
            crossDown,
        });
        if (crossUp) {
            this.lastCrossDirection = 'up';
            this.lastCrossAtMs = Date.now();
            // Record cross for regime filter.
            this.crossTimestamps.push(Date.now());
            if (this.crossTimestamps.length > ArbStrategy.REGIME_MAX_CROSSES) {
                // Too many EMA crosses in the window — market is choppy, pause 30s.
                logger_js_1.default.warn('Regime filter triggered — too many EMA crosses, pausing 30s', {
                    crossCount: this.crossTimestamps.length,
                    windowMs: ArbStrategy.REGIME_WINDOW_MS,
                });
                this.regimePausedUntilMs = Date.now() + 30 * 1000;
            }
        }
        else if (crossDown) {
            this.lastCrossDirection = 'down';
            this.lastCrossAtMs = Date.now();
            // Record cross for regime filter.
            this.crossTimestamps.push(Date.now());
            if (this.crossTimestamps.length > ArbStrategy.REGIME_MAX_CROSSES) {
                logger_js_1.default.warn('Regime filter triggered — too many EMA crosses, pausing 30s', {
                    crossCount: this.crossTimestamps.length,
                    windowMs: ArbStrategy.REGIME_WINDOW_MS,
                });
                this.regimePausedUntilMs = Date.now() + 30 * 1000;
            }
        }
        // --- Update extremum tracking while holding (not during pending phases) ---
        if (isLong) {
            this.peakCoinbase = this.peakCoinbase === null ? coinbasePrice : Math.max(this.peakCoinbase, coinbasePrice);
            this.troughCoinbase = null;
        }
        else if (isShort) {
            this.troughCoinbase = this.troughCoinbase === null ? coinbasePrice : Math.min(this.troughCoinbase, coinbasePrice);
            this.peakCoinbase = null;
        }
        else {
            this.peakCoinbase = null;
            this.troughCoinbase = null;
        }
        logger_js_1.default.debug('Cross detection', {
            prevPrice: prevPrice.toFixed(2),
            currPrice: coinbasePrice.toFixed(2),
            kalshiUnderlyingPrice: kalshiUnderlyingPriceDollars.toFixed(2),
            crossUp,
            crossDown,
            rising,
            falling,
            positionContracts,
            peakCoinbase: this.peakCoinbase,
            troughCoinbase: this.troughCoinbase,
        });
        // --- Flat: enter based on EMA crossover direction ---
        if (isFlat) {
            if (crossUp) {
                // EMA5 crossed above EMA20 → Coinbase just flipped bullish.
                // Kalshi is lagging — YES contracts still cheap. Enter long.
                // Spread gate: skip if Kalshi spread is too wide (illiquid market).
                const yesSpread = market.yes_ask - market.yes_bid;
                if (yesSpread > 8) {
                    return this.hold(`Spread too wide for YES entry: ${yesSpread}¢ > 8¢`);
                }
                const entryRes = await this.placeEntryOrder(market, 'yes');
                if (entryRes.action === 'hold')
                    return entryRes;
                this.pendingSide = 'long';
                this.pendingPhase = 'entry';
                this.pendingSinceMs = Date.now();
                this.peakCoinbase = coinbasePrice;
                return {
                    ...entryRes,
                    pendingPhase: this.pendingPhase,
                    pendingSide: this.pendingSide,
                    coinbasePrice,
                    referencePriceDollars: targetPriceDollars,
                    kalshiUnderlyingPriceDollars,
                };
            }
            if (crossDown) {
                // EMA5 crossed below EMA20 → Coinbase just flipped bearish.
                // Kalshi is lagging — NO contracts still cheap. Enter short.
                // Spread gate: skip if Kalshi spread is too wide (illiquid market).
                const noSpread = market.no_ask - market.no_bid;
                if (noSpread > 8) {
                    return this.hold(`Spread too wide for NO entry: ${noSpread}¢ > 8¢`);
                }
                const entryRes = await this.placeEntryOrder(market, 'no');
                if (entryRes.action === 'hold')
                    return entryRes;
                this.pendingSide = 'short';
                this.pendingPhase = 'entry';
                this.pendingSinceMs = Date.now();
                this.troughCoinbase = coinbasePrice;
                return {
                    ...entryRes,
                    pendingPhase: this.pendingPhase,
                    pendingSide: this.pendingSide,
                    coinbasePrice,
                    referencePriceDollars: targetPriceDollars,
                    kalshiUnderlyingPriceDollars,
                };
            }
            return this.hold('Flat; no qualifying intersection');
        }
        // --- Long -> exit on down-cross ---
        if (isLong && crossDown) {
            const exitYesLimitCents = Math.max(market.yes_bid, 1);
            const count = Math.abs(positionContracts);
            const exitRes = await this.placeExitOrder(market, 'yes', count, exitYesLimitCents);
            if (exitRes.action === 'hold')
                return exitRes;
            this.armedTpExitLimitCents = exitYesLimitCents;
            this.armedTpExitSide = 'yes';
            this.pendingSide = 'short';
            this.pendingPhase = 'exit';
            this.pendingSinceMs = Date.now();
            this.pendingExitOrderId = exitRes.orderId ?? null;
            return {
                ...exitRes,
                exitLimitCents: exitYesLimitCents,
                pendingPhase: this.pendingPhase,
                pendingSide: this.pendingSide,
                coinbasePrice,
                referencePriceDollars: targetPriceDollars,
                kalshiUnderlyingPriceDollars,
            };
        }
        // --- Short -> exit on up-cross ---
        if (isShort && crossUp) {
            const exitNoLimitCents = Math.max(market.no_bid, 1);
            const count = Math.abs(positionContracts);
            const exitRes = await this.placeExitOrder(market, 'no', count, exitNoLimitCents);
            if (exitRes.action === 'hold')
                return exitRes;
            this.armedTpExitLimitCents = exitNoLimitCents;
            this.armedTpExitSide = 'no';
            this.pendingSide = 'long';
            this.pendingPhase = 'exit';
            this.pendingSinceMs = Date.now();
            this.pendingExitOrderId = exitRes.orderId ?? null;
            return {
                ...exitRes,
                exitLimitCents: exitNoLimitCents,
                pendingPhase: this.pendingPhase,
                pendingSide: this.pendingSide,
                coinbasePrice,
                referencePriceDollars: targetPriceDollars,
                kalshiUnderlyingPriceDollars,
            };
        }
        // No action this tick.
        return this.hold('Hold (no qualifying intersection for current position)');
    }
    async canPlaceNewOrder(ticker) {
        const msSinceLastOrder = Date.now() - this.lastOrderTime;
        if (this.lastOrderTime > 0 && msSinceLastOrder < config_js_1.config.strategy.orderCooldownMs) {
            return {
                ok: false,
                reason: `Order cooldown active (${((config_js_1.config.strategy.orderCooldownMs - msSinceLastOrder) / 1000).toFixed(1)}s remaining)`,
            };
        }
        if (config_js_1.config.dryRun)
            return { ok: true };
        await this.refreshOpenOrders(ticker);
        if (this.openOrderIds.length >= config_js_1.config.strategy.maxOpenOrders) {
            return {
                ok: false,
                reason: `Too many open orders (${this.openOrderIds.length}/${config_js_1.config.strategy.maxOpenOrders})`,
            };
        }
        return { ok: true };
    }
    /**
     * Force-refresh position from the API (bypasses the 500ms cache) and return the net contract count.
     * Used before emergency flattens to ensure we don't sell more contracts than we actually hold.
     */
    async fetchFreshPositionContracts(ticker) {
        const positions = await this.kalshiClient.getPositions();
        const contracts = positions.find((p) => p.ticker === ticker)?.position ?? 0;
        this.cachedPositionContracts = contracts;
        this.lastPositionFetchMs = Date.now();
        return contracts;
    }
    /** Like `canPlaceNewOrder` but skips cooldown so market flatten can run right after a limit exit. */
    async canPlaceExitFlattenOrder(ticker) {
        if (config_js_1.config.dryRun)
            return { ok: true };
        await this.refreshOpenOrders(ticker);
        if (this.openOrderIds.length >= config_js_1.config.strategy.maxOpenOrders) {
            return {
                ok: false,
                reason: `Too many open orders (${this.openOrderIds.length}/${config_js_1.config.strategy.maxOpenOrders})`,
            };
        }
        return { ok: true };
    }
    /**
     * Best-effort cancel of all tracked open orders before emergency flatten,
     * so market exits are not blocked by max-open-order limits.
     */
    async cancelTrackedOpenOrdersForFlatten() {
        if (config_js_1.config.dryRun || this.openOrderIds.length === 0)
            return;
        const ids = [...new Set(this.openOrderIds)];
        for (const orderId of ids) {
            try {
                await this.kalshiClient.cancelOrder(orderId);
            }
            catch (err) {
                logger_js_1.default.warn('Failed to cancel tracked order during emergency flatten', {
                    orderId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        this.openOrderIds = [];
    }
    applySimulatedOrder(side, action, count) {
        // net contracts representation:
        //   position > 0: net YES
        //   position < 0: net NO
        if (action === 'buy' && side === 'yes')
            this.simulatedPositionContracts += count;
        else if (action === 'buy' && side === 'no')
            this.simulatedPositionContracts -= count;
        else if (action === 'sell' && side === 'yes')
            this.simulatedPositionContracts -= count;
        else if (action === 'sell' && side === 'no')
            this.simulatedPositionContracts += count;
    }
    clamp(n, lo, hi) {
        return Math.max(lo, Math.min(hi, n));
    }
    /**
     * Map a Coinbase BTC price (in dollars) to a Kalshi YES limit price (0-100 cents).
     *
     * This reuses the repo's existing sigmoid-like approximation:
     *   theoretical_yes_prob = 50 + (deltaPct / 0.1) * 15, clamped to [20, 80]
     *
     * Where deltaPct = ((price - strike) / strike) * 100.
     */
    coinbaseToYesLimitCents(coinbasePriceDollars, strikeDollars) {
        const strike = strikeDollars;
        const deltaPct = ((coinbasePriceDollars - strike) / strike) * 100;
        const theoreticalYesProb = this.computeTheoreticalYesProb(deltaPct); // 20..80
        return this.clamp(Math.round(theoreticalYesProb), 1, 99);
    }
    coinbaseToNoLimitCents(coinbasePriceDollars, strikeDollars) {
        const yesLimitCents = this.coinbaseToYesLimitCents(coinbasePriceDollars, strikeDollars);
        // In a binary market, NO is typically the complement of YES.
        return this.clamp(100 - yesLimitCents, 1, 99);
    }
    async placeEntryOrder(market, side) {
        // Check only the side we intend to enter — avoids blocking valid YES entries
        // when NO contracts are worthless (deep ITM) and vice versa.
        if (this.isOrderbookUnavailable(market, side)) {
            return this.hold(`Orderbook unavailable for ${side.toUpperCase()} entry`);
        }
        const can = await this.canPlaceNewOrder(market.ticker);
        if (!can.ok)
            return this.hold(can.reason ?? 'Cannot place entry order');
        const askPriceCents = side === 'yes' ? market.yes_ask : market.no_ask;
        const bidPriceCents = side === 'yes' ? market.yes_bid : market.no_bid;
        // Edge check: ensure Kalshi hasn't already repriced before we enter.
        // Fair value is computed from Coinbase displacement vs strike using the same sigmoid used for orders.
        const strikeDollars = market.expiration_value_dollars ?? config_js_1.config.strategy.referencePriceDollars;
        const coinbasePrice = this.lastEvaluatedCoinbasePrice ?? strikeDollars;
        const fairValueYesCents = this.coinbaseToYesLimitCents(coinbasePrice, strikeDollars);
        const fairValueCents = side === 'yes' ? fairValueYesCents : (100 - fairValueYesCents);
        const spread = askPriceCents - bidPriceCents;
        // Required edge must cover the spread plus a profit buffer.
        const requiredEdge = Math.max(config_js_1.config.strategy.kalshiEdgeThreshold, spread + 3);
        const edge = fairValueCents - askPriceCents;
        if (edge < requiredEdge) {
            logger_js_1.default.info('Edge check failed — Kalshi already repriced', {
                side, askPriceCents, fairValueCents, edge: edge.toFixed(1), requiredEdge: requiredEdge.toFixed(1), spread,
            });
            return this.hold(`Edge ${edge.toFixed(1)}c < required ${requiredEdge.toFixed(1)}c — market already repriced`);
        }
        const balanceCents = config_js_1.config.dryRun ? this.demoCashCents : await this.kalshiClient.getBalance();
        // Pass edge for dynamic sizing: higher edge → larger position (capped at maxPositionSize).
        const count = this.computePositionSize(balanceCents, askPriceCents, edge);
        if (count < 1) {
            return this.hold(`Insufficient balance for entry (balance: ${balanceCents} cents, ask: ${askPriceCents} cents)`);
        }
        const orderReq = {
            ticker: market.ticker,
            side,
            count,
            action: 'buy',
            type: 'limit',
            ...(side === 'yes' ? { yes_price: askPriceCents } : { no_price: askPriceCents }),
        };
        const action = side === 'yes' ? 'buy_yes' : 'buy_no';
        const totalCostDollars = (count * askPriceCents) / 100;
        if (config_js_1.config.dryRun) {
            logger_js_1.default.info('[DRY RUN] Would place ENTRY order', {
                ticker: market.ticker,
                side,
                count,
                priceCents: askPriceCents,
                totalCostDollars: totalCostDollars.toFixed(2),
            });
            this.applySimulatedOrder(side, 'buy', count);
            this.demoCashCents -= count * askPriceCents;
            this.lastOrderTime = Date.now();
            // Track entry for dashboard “current trade P/L”.
            this.currentTradeSide = side;
            this.currentTradeEntryLimitCents = askPriceCents;
            this.currentTradeCount = count;
            this.currentTradePnLCents = 0;
            this.currentTradePnLMode = 'unrealized';
            return {
                action,
                reason: `[DRY RUN] Would buy ${count} ${side.toUpperCase()} @ ${askPriceCents}¢`,
                tradeKind: 'entry',
                orderAction: 'buy',
                side,
                count,
                limitPriceCents: askPriceCents,
            };
        }
        try {
            const order = await this.kalshiClient.placeOrder(orderReq);
            this.lastOrderTime = Date.now();
            this.openOrderIds.push(order.order_id);
            logger_js_1.default.info('Placed Kalshi ENTRY order', {
                orderId: order.order_id,
                ticker: market.ticker,
                side,
                count,
                priceCents: askPriceCents,
                totalCostDollars: totalCostDollars.toFixed(2),
            });
            // Track entry for dashboard “current trade P/L”.
            this.currentTradeSide = side;
            this.currentTradeEntryLimitCents = askPriceCents;
            this.currentTradeCount = count;
            this.currentTradePnLCents = 0;
            this.currentTradePnLMode = 'unrealized';
            return {
                action,
                reason: `Bought ${count} ${side.toUpperCase()} @ ${askPriceCents}¢`,
                orderId: order.order_id,
                tradeKind: 'entry',
                orderAction: 'buy',
                side,
                count,
                limitPriceCents: askPriceCents,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger_js_1.default.error('Failed to place Kalshi ENTRY order', { error: msg, side, count, askPriceCents });
            return this.hold(`Entry placement failed: ${msg}`);
        }
    }
    async placeExitOrder(market, side, count, limitPriceCents) {
        if (this.isOrderbookUnavailable(market)) {
            return this.hold('Orderbook unavailable — exit blocked');
        }
        const can = await this.canPlaceNewOrder(market.ticker);
        if (!can.ok)
            return this.hold(can.reason ?? 'Cannot place exit order');
        if (count < 1) {
            return this.hold(`Invalid exit count: ${count}`);
        }
        const orderReq = {
            ticker: market.ticker,
            side,
            count,
            action: 'sell',
            type: 'ioc', // Kalshi requires IoC when reduce_only is set
            reduce_only: true, // tells Kalshi this closes an existing position — no margin required
            ...(side === 'yes' ? { yes_price: limitPriceCents } : { no_price: limitPriceCents }),
        };
        const action = side === 'yes' ? 'sell_yes' : 'sell_no';
        const totalDollars = (count * limitPriceCents) / 100;
        if (config_js_1.config.dryRun) {
            logger_js_1.default.info('[DRY RUN] Would place EXIT order', {
                ticker: market.ticker,
                side,
                count,
                limitPriceCents,
                totalDollars: totalDollars.toFixed(2),
            });
            this.applySimulatedOrder(side, 'sell', count);
            this.demoCashCents += count * limitPriceCents;
            this.lastOrderTime = Date.now();
            return {
                action,
                reason: `[DRY RUN] Would sell ${count} ${side.toUpperCase()} @ ${limitPriceCents}¢`,
                tradeKind: 'exit',
                orderAction: 'sell',
                side,
                count,
                limitPriceCents,
            };
        }
        try {
            const order = await this.kalshiClient.placeOrder(orderReq);
            this.lastOrderTime = Date.now();
            this.openOrderIds.push(order.order_id);
            logger_js_1.default.info('Placed Kalshi EXIT order', {
                orderId: order.order_id,
                ticker: market.ticker,
                side,
                count,
                limitPriceCents,
                totalDollars: totalDollars.toFixed(2),
            });
            return {
                action,
                reason: `Sold ${count} ${side.toUpperCase()} @ ${limitPriceCents}¢`,
                orderId: order.order_id,
                tradeKind: 'exit',
                orderAction: 'sell',
                side,
                count,
                limitPriceCents,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger_js_1.default.error('Failed to place Kalshi EXIT order', { error: msg, side, count, limitPriceCents });
            return this.hold(`Exit placement failed: ${msg}`);
        }
    }
    async placeMarketExitOrder(market, side, count) {
        if (this.isOrderbookUnavailable(market)) {
            return this.hold('Orderbook unavailable — market exit blocked');
        }
        const can = await this.canPlaceExitFlattenOrder(market.ticker);
        if (!can.ok)
            return this.hold(can.reason ?? 'Cannot place market exit order');
        if (count < 1) {
            return this.hold(`Invalid market exit count: ${count}`);
        }
        // Kalshi does not support true market orders — a price is always required.
        // Use the current bid as the limit price. This fills immediately against resting bids
        // and avoids the margin Kalshi charges when the price is far from market (e.g. 1¢ sell
        // causes Kalshi to reserve 99¢/contract margin as if it were a new short).
        const bid = side === 'yes' ? market.yes_bid : market.no_bid;
        const aggressivePriceCents = Math.max(bid, 1);
        const orderReq = {
            ticker: market.ticker,
            side,
            count,
            action: 'sell',
            type: 'ioc', // Kalshi requires IoC when reduce_only is set
            reduce_only: true, // tells Kalshi this closes an existing position — no margin required
            ...(side === 'yes' ? { yes_price: aggressivePriceCents } : { no_price: aggressivePriceCents }),
        };
        const action = side === 'yes' ? 'sell_yes' : 'sell_no';
        if (config_js_1.config.dryRun) {
            logger_js_1.default.info('[DRY RUN] Would place MARKET EXIT order (aggressive limit @ 1¢)', {
                ticker: market.ticker,
                side,
                count,
            });
            this.applySimulatedOrder(side, 'sell', count);
            const bid = side === 'yes' ? market.yes_bid : market.no_bid;
            this.demoCashCents += count * bid;
            this.lastOrderTime = Date.now();
            return {
                action,
                reason: `[DRY RUN] Market sell ${count} ${side.toUpperCase()}`,
                tradeKind: 'exit',
                orderAction: 'sell',
                side,
                count,
            };
        }
        try {
            const order = await this.kalshiClient.placeOrder(orderReq);
            this.lastOrderTime = Date.now();
            this.openOrderIds.push(order.order_id);
            logger_js_1.default.info('Placed Kalshi MARKET EXIT order (aggressive limit @ 1¢)', {
                orderId: order.order_id,
                ticker: market.ticker,
                side,
                count,
                priceCents: aggressivePriceCents,
            });
            return {
                action,
                reason: `Market sell ${count} ${side.toUpperCase()}`,
                orderId: order.order_id,
                tradeKind: 'exit',
                orderAction: 'sell',
                side,
                count,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger_js_1.default.error('Failed to place Kalshi MARKET EXIT order', { error: msg, side, count });
            return this.hold(`Market exit placement failed: ${msg}`);
        }
    }
    /**
     * Checks TP, SL, and TTE-based exits. Returns an exit result if we should close,
     * null if position should be held or there's nothing to do.
     * Called before cross detection so exits fire on every tick.
     */
    async checkProfitAndLossExits(market, coinbasePrice, positionContracts, targetPriceDollars, secsLeft) {
        const isLong = positionContracts > 0;
        const isShort = positionContracts < 0;
        if (!isLong && !isShort)
            return null;
        if (this.pendingPhase)
            return null;
        if (this.currentTradeEntryLimitCents === null)
            return null;
        const heldSide = isLong ? 'yes' : 'no';
        const bid = heldSide === 'yes' ? market.yes_bid : market.no_bid;
        const entry = this.currentTradeEntryLimitCents;
        const count = Math.abs(positionContracts);
        const pnlCents = bid - entry;
        // Helper: place exit and immediately set pendingPhase to prevent duplicate orders
        // being fired on subsequent ticks before the position cache refreshes (500ms TTL).
        const fireExit = async (reason) => {
            // Record realized P/L immediately using current bid as the exit estimate.
            if (this.currentTradeEntryLimitCents !== null && this.currentTradeCount !== null) {
                const realized = count * (bid - this.currentTradeEntryLimitCents);
                this.currentTradePnLCents = Math.round(realized);
                this.currentTradePnLMode = 'realized';
                // Arm exit price for pending-phase P/L reconciliation.
                this.armedTpExitLimitCents = bid;
                this.armedTpExitSide = heldSide;
            }
            const exitRes = await this.placeMarketExitOrder(market, heldSide, count);
            if (exitRes.action !== 'hold') {
                // Lock out further exit attempts until position cache confirms flat.
                this.pendingPhase = 'exit';
                this.pendingSide = isLong ? 'short' : 'long';
                this.pendingSinceMs = Date.now();
                this.pendingExitOrderId = exitRes.orderId ?? null;
                // Force-invalidate position cache so next tick fetches fresh data.
                this.lastPositionFetchMs = 0;
                logger_js_1.default.info(reason, { heldSide, bid, entry, pnlCents, count });
            }
            return exitRes;
        };
        // Take profit (flat): Kalshi has repriced in our favor by takeProfitCents.
        if (config_js_1.config.strategy.takeProfitCents > 0 && pnlCents >= config_js_1.config.strategy.takeProfitCents) {
            return await fireExit(`TAKE PROFIT triggered (+${pnlCents}c flat)`);
        }
        // Take profit (proportional): P&L has reached takeProfitPct of cost basis.
        // e.g. entry=43c, pct=0.10 → fires when bid >= 47.3c (+4.3c on 43c entry).
        if (config_js_1.config.strategy.takeProfitPct > 0 && entry > 0) {
            const tpThresholdCents = entry * config_js_1.config.strategy.takeProfitPct;
            if (pnlCents >= tpThresholdCents) {
                const pnlPct = ((pnlCents / entry) * 100).toFixed(1);
                return await fireExit(`TAKE PROFIT triggered (+${pnlCents.toFixed(1)}c = +${pnlPct}% of entry)`);
            }
        }
        // Stop loss: underwater by stopLossCents at any time.
        if (pnlCents <= -config_js_1.config.strategy.stopLossCents) {
            return await fireExit(`STOP LOSS triggered (${pnlCents}c)`);
        }
        // Near expiry (<3 min): hold if winning, cut if losing.
        if (secsLeft < 180) {
            const btcAboveStrike = coinbasePrice > targetPriceDollars;
            const positionIsWinning = (isLong && btcAboveStrike) || (isShort && !btcAboveStrike);
            if (!positionIsWinning && pnlCents < -3) {
                return await fireExit(`Near-expiry cut-loss triggered (${secsLeft.toFixed(0)}s left, ${pnlCents}c)`);
            }
            if (positionIsWinning) {
                // Hold to expiry — let theta work for us.
                return this.hold(`Near expiry, holding winner (${secsLeft.toFixed(0)}s left, ${pnlCents >= 0 ? '+' : ''}${pnlCents}c)`);
            }
        }
        // Thesis failure: still losing with <5 min left.
        if (secsLeft < 300 && pnlCents < -5) {
            return await fireExit(`Thesis-failure exit (${secsLeft.toFixed(0)}s left, ${pnlCents}c)`);
        }
        return null;
    }
    hold(reason) {
        return { action: 'hold', reason };
    }
    /**
     * Cancel all tracked open orders. Called on shutdown.
     */
    async cancelAllOpenOrders() {
        if (this.openOrderIds.length === 0) {
            logger_js_1.default.info('No open orders to cancel');
            return;
        }
        logger_js_1.default.info(`Cancelling ${this.openOrderIds.length} open order(s)...`);
        const ids = [...this.openOrderIds];
        for (const orderId of ids) {
            try {
                await this.kalshiClient.cancelOrder(orderId);
                this.openOrderIds = this.openOrderIds.filter((id) => id !== orderId);
            }
            catch (err) {
                logger_js_1.default.warn('Failed to cancel order on shutdown', {
                    orderId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    getOpenOrderIds() {
        return [...this.openOrderIds];
    }
}
exports.ArbStrategy = ArbStrategy;
//# sourceMappingURL=arbStrategy.js.map