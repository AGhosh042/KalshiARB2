"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_js_1 = require("./config.js");
const logger_js_1 = __importDefault(require("./utils/logger.js"));
const client_js_1 = require("./coinbase/client.js");
const client_js_2 = require("./kalshi/client.js");
const arbStrategy_js_1 = require("./strategy/arbStrategy.js");
async function main() {
    logger_js_1.default.info('=== Kalshi BTC Latency Arbitrage Bot Starting ===');
    logger_js_1.default.info('Configuration loaded', {
        dryRun: config_js_1.config.dryRun,
        marketTicker: config_js_1.config.kalshi.marketTicker,
        pollIntervalMs: config_js_1.config.strategy.pollIntervalMs,
        priceMoveThresholdPct: config_js_1.config.strategy.priceMoveThresholdPct,
        kalshiEdgeThreshold: config_js_1.config.strategy.kalshiEdgeThreshold,
        maxPositionSize: config_js_1.config.strategy.maxPositionSize,
        maxOpenOrders: config_js_1.config.strategy.maxOpenOrders,
        trendWindowSeconds: config_js_1.config.strategy.trendWindowSeconds,
    });
    if (config_js_1.config.dryRun) {
        logger_js_1.default.warn('DRY RUN MODE ENABLED — no real orders will be placed');
    }
    // Instantiate core components
    const coinbaseClient = new client_js_1.CoinbaseClient();
    const kalshiClient = new client_js_2.KalshiClient();
    const strategy = new arbStrategy_js_1.ArbStrategy(kalshiClient);
    // Current Kalshi ticker in use (supports auto-rotation).
    let currentMarketTicker = config_js_1.config.kalshi.marketTicker;
    // Shared state between the Kalshi fetch loop and the evaluation handler.
    let latestMarket = null;
    let isEvaluating = false;
    let fetchLoopActive = true;
    let balanceLogTimer = null;
    let statusTimer = null;
    // Cached state for the periodic status display (avoids extra API calls on every tick).
    let cachedBalanceCents = 0;
    let cachedPositionContracts = 0;
    let cachedStartBalanceCents = 0;
    let lastPositionFetchMs = 0;
    // Evaluation runs on every Coinbase price update using the last-known Kalshi market.
    // This decouples evaluation latency from Kalshi REST round-trip time.
    async function evaluateOnTick(coinbaseData) {
        if (!latestMarket) {
            logger_js_1.default.debug('No Kalshi market data yet — waiting for first fetch');
            return;
        }
        if (isEvaluating)
            return;
        isEvaluating = true;
        try {
            logger_js_1.default.debug('Market state', {
                ticker: latestMarket.ticker,
                status: latestMarket.status,
                yes_bid: latestMarket.yes_bid,
                yes_ask: latestMarket.yes_ask,
                no_bid: latestMarket.no_bid,
                no_ask: latestMarket.no_ask,
                closeTime: latestMarket.close_time,
            });
            const result = await strategy.evaluate(coinbaseData, latestMarket);
            if (result.action !== 'hold') {
                logger_js_1.default.info('Strategy decision', {
                    action: result.action,
                    reason: result.reason,
                    ...(result.orderId ? { orderId: result.orderId } : {}),
                    ...(result.coinbasePrice !== undefined ? { coinbasePrice: result.coinbasePrice.toFixed(2) } : {}),
                    ...(result.referencePriceDollars !== undefined
                        ? { referencePriceDollars: result.referencePriceDollars.toFixed(2) }
                        : {}),
                    ...(result.kalshiUnderlyingPriceDollars !== undefined
                        ? { kalshiUnderlyingPriceDollars: result.kalshiUnderlyingPriceDollars.toFixed(2) }
                        : {}),
                    ...(result.recordedPeak !== undefined ? { recordedPeak: result.recordedPeak.toFixed(2) } : {}),
                    ...(result.recordedTrough !== undefined ? { recordedTrough: result.recordedTrough.toFixed(2) } : {}),
                    ...(result.exitLimitCents !== undefined ? { exitLimitCents: result.exitLimitCents } : {}),
                    ...(result.pendingPhase !== undefined ? { pendingPhase: result.pendingPhase } : {}),
                    ...(result.pendingSide !== undefined ? { pendingSide: result.pendingSide } : {}),
                });
            }
            else {
                logger_js_1.default.debug('Strategy holding', { reason: result.reason });
            }
        }
        catch (err) {
            logger_js_1.default.error('Unhandled error in evaluation', {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
        }
        finally {
            isEvaluating = false;
        }
    }
    // Wire Coinbase price updates directly to evaluation — no timer involved.
    coinbaseClient.on('priceUpdate', (data) => {
        void evaluateOnTick(data);
    });
    // Kalshi market fetch loop — runs as fast as the REST API allows, completely
    // independent of Coinbase events and evaluation.
    async function runKalshiFetchLoop() {
        while (fetchLoopActive) {
            try {
                let market = await kalshiClient.getMarket(currentMarketTicker);
                // Auto-rotate market ticker close to expiry.
                // Only rotate when we have no pending state and are flat.
                try {
                    const closeMs = new Date(market.close_time).getTime();
                    const shouldRotate = market.status !== 'open' || closeMs - Date.now() <= 10_000;
                    const isPending = strategy.getPendingPhase() !== null && strategy.getPendingSide() !== null;
                    if (shouldRotate && !isPending) {
                        const positions = await kalshiClient.getPositions();
                        const positionContracts = positions.find((p) => p.ticker === currentMarketTicker)?.position ?? 0;
                        if (positionContracts === 0) {
                            const prefix = currentMarketTicker.split('-')[0].toUpperCase();
                            const openMarkets = await kalshiClient.getMarkets({ seriesTicker: prefix, status: 'open', limit: 100 });
                            const nowMs = Date.now();
                            const next = openMarkets
                                .filter((m) => m.close_time && new Date(m.close_time).getTime() >= nowMs)
                                .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];
                            if (next && next.ticker !== currentMarketTicker) {
                                logger_js_1.default.info('Auto-rotating market ticker', {
                                    from: currentMarketTicker,
                                    to: next.ticker,
                                    closeTime: next.close_time,
                                });
                                currentMarketTicker = next.ticker;
                                market = next;
                            }
                        }
                    }
                }
                catch {
                    // Best-effort; ignore rotation failures.
                }
                latestMarket = market;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const is404 = /\[404\]|not found/i.test(msg);
                if (is404) {
                    // Ask the API for the current open market instead of guessing the ticker format.
                    try {
                        const prefix = currentMarketTicker.split('-')[0].toUpperCase();
                        const openMarkets = await kalshiClient.getMarkets({ seriesTicker: prefix, status: 'open', limit: 100 });
                        const nowMs = Date.now();
                        const best = openMarkets
                            .filter((m) => m.close_time && new Date(m.close_time).getTime() >= nowMs)
                            .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];
                        if (best) {
                            logger_js_1.default.warn('Recovered market ticker after 404', { from: currentMarketTicker, to: best.ticker });
                            currentMarketTicker = best.ticker;
                            latestMarket = best;
                        }
                        else {
                            logger_js_1.default.warn('No open market found for series — waiting 5s', { series: prefix });
                            await new Promise((resolve) => setTimeout(resolve, 5_000));
                        }
                    }
                    catch {
                        await new Promise((resolve) => setTimeout(resolve, 5_000));
                    }
                }
                else {
                    logger_js_1.default.warn('Failed to fetch Kalshi market — retrying', { error: msg });
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                }
            }
        }
    }
    // --- Log balance every 60 seconds (also seeds cachedBalanceCents) ---
    async function logBalance() {
        try {
            const balanceCents = config_js_1.config.dryRun
                ? strategy.getDemoCashCents()
                : await kalshiClient.getBalance();
            cachedBalanceCents = balanceCents;
            if (cachedStartBalanceCents === 0)
                cachedStartBalanceCents = balanceCents;
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
    }
    // --- Periodic status display: mirrors all web dashboard stats to the terminal ---
    async function logStatus() {
        // Update position cache — live mode polls every 5s, dry-run reads in-memory.
        if (config_js_1.config.dryRun) {
            cachedPositionContracts = strategy.getDemoPositionContracts();
            cachedBalanceCents = strategy.getDemoCashCents();
            if (cachedStartBalanceCents === 0)
                cachedStartBalanceCents = strategy.getDemoStartingCashCents();
        }
        else if (Date.now() - lastPositionFetchMs >= 5_000) {
            try {
                const positions = await kalshiClient.getPositions();
                cachedPositionContracts =
                    positions.find((p) => p.ticker === currentMarketTicker)?.position ?? 0;
                lastPositionFetchMs = Date.now();
            }
            catch {
                // keep last known value
            }
        }
        const coinbasePrice = strategy.getLastObservedCoinbasePriceDollars();
        const underlying = strategy.getLastObservedKalshiUnderlyingPriceDollars();
        const target = strategy.getLastTargetPriceDollars();
        const diff = strategy.getLastCoinbaseMinusUnderlyingDollars();
        const direction = strategy.getLastCoinbaseDirection();
        const crossDir = strategy.getLastCrossDirection();
        const crossAt = strategy.getLastCrossAtMs();
        const tpCents = strategy.getArmedTpExitLimitCents();
        const tpSide = strategy.getArmedTpExitSide();
        const pendingPhase = strategy.getPendingPhase();
        const pendingSide = strategy.getPendingSide();
        const tradePnLCents = strategy.getCurrentTradePnLCents();
        const tradePnLMode = strategy.getCurrentTradePnLMode();
        const tradeSide = strategy.getCurrentTradeSide();
        const tradeEntry = strategy.getCurrentTradeEntryLimitCents();
        const tradeCount = strategy.getCurrentTradeCount();
        const openOrders = strategy.getOpenOrderIds().length;
        const posSide = cachedPositionContracts > 0 ? 'LONG' : cachedPositionContracts < 0 ? 'SHORT' : 'FLAT';
        const diffPct = underlying && underlying > 0 && diff !== null
            ? ((diff / underlying) * 100).toFixed(4)
            : null;
        const pnlCents = cachedBalanceCents - cachedStartBalanceCents;
        logger_js_1.default.info('── STATUS ──', {
            prices: {
                coinbase: coinbasePrice !== null ? `$${coinbasePrice.toFixed(2)}` : '—',
                underlying: underlying !== null ? `$${underlying.toFixed(2)}` : '—',
                target: target !== null ? `$${target.toFixed(2)}` : '—',
                diff: diff !== null
                    ? `${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} (${diffPct ?? '—'}%)`
                    : '—',
                direction: direction?.toUpperCase() ?? '—',
            },
            position: `${posSide} (${Math.abs(cachedPositionContracts)} contracts)`,
            openOrders,
            cross: crossDir
                ? `${crossDir.toUpperCase()} @ ${crossAt ? new Date(crossAt).toLocaleTimeString() : '—'}`
                : '—',
            armedTP: tpCents !== null ? `${tpSide?.toUpperCase()} @ ${tpCents}¢` : '—',
            pending: pendingPhase ? `${pendingPhase} → ${pendingSide}` : 'none',
            balance: `$${(cachedBalanceCents / 100).toFixed(2)}`,
            pnl: `${pnlCents >= 0 ? '+' : ''}$${(pnlCents / 100).toFixed(2)} since start`,
            tradePnL: tradePnLCents !== null
                ? `${tradePnLCents >= 0 ? '+' : ''}$${(tradePnLCents / 100).toFixed(2)} (${tradePnLMode?.toUpperCase()} ${tradeSide?.toUpperCase()} x${tradeCount} @ ${tradeEntry}¢)`
                : '—',
            ticker: currentMarketTicker,
        });
    }
    // Log balance immediately at startup, then every 60s
    void logBalance();
    balanceLogTimer = setInterval(() => void logBalance(), 60_000);
    // Status display every 2 seconds
    statusTimer = setInterval(() => void logStatus(), 2_000);
    // Auto-discover the current open market before starting — never rely on a stale .env ticker.
    try {
        const prefix = currentMarketTicker.split('-')[0].toUpperCase();
        const openMarkets = await kalshiClient.getMarkets({ seriesTicker: prefix, status: 'open', limit: 100 });
        const now = Date.now();
        const best = openMarkets
            .filter((m) => m.close_time && new Date(m.close_time).getTime() >= now)
            .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];
        if (best && best.ticker !== currentMarketTicker) {
            logger_js_1.default.info('Auto-discovered current Kalshi market at startup', {
                configured: currentMarketTicker,
                active: best.ticker,
                closeTime: best.close_time,
            });
            currentMarketTicker = best.ticker;
        }
    }
    catch (err) {
        logger_js_1.default.warn('Could not auto-discover market ticker at startup — using configured value', {
            ticker: currentMarketTicker,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    // Start both loops — they run independently.
    coinbaseClient.connect();
    void runKalshiFetchLoop();
    // --- Graceful shutdown ---
    async function shutdown(signal) {
        logger_js_1.default.info(`Received ${signal} — shutting down gracefully...`);
        fetchLoopActive = false;
        if (balanceLogTimer) {
            clearInterval(balanceLogTimer);
            balanceLogTimer = null;
        }
        if (statusTimer) {
            clearInterval(statusTimer);
            statusTimer = null;
        }
        // Disconnect Coinbase WebSocket
        coinbaseClient.disconnect();
        // Cancel all open Kalshi orders (unless dry run)
        if (!config_js_1.config.dryRun) {
            await strategy.cancelAllOpenOrders();
        }
        else {
            const openIds = strategy.getOpenOrderIds();
            if (openIds.length > 0) {
                logger_js_1.default.info('[DRY RUN] Would cancel open orders on shutdown', { orderIds: openIds });
            }
        }
        logger_js_1.default.info('Shutdown complete. Goodbye.');
        process.exit(0);
    }
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    // Unhandled rejection safety net
    process.on('unhandledRejection', (reason) => {
        logger_js_1.default.error('Unhandled Promise rejection', {
            reason: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined,
        });
    });
    logger_js_1.default.info('Bot is running. Press Ctrl+C to stop.');
}
main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('Fatal error starting bot:', msg, stack);
    process.exit(1);
});
//# sourceMappingURL=index.js.map