export interface Config {
    kalshi: {
        apiKeyId: string;
        privateKeyPem: string;
        /** e.g. production https://api.elections.kalshi.com/trade-api/v2 or demo https://demo-api.kalshi.co/trade-api/v2 */
        baseUrl: string;
        marketTicker: string;
    };
    coinbase: {
        apiKey: string;
        apiSecret: string;
        wsUrl: string;
        productId: string;
    };
    strategy: {
        priceMoveThresholdPct: number;
        kalshiEdgeThreshold: number;
        referencePriceDollars: number;
        maxPositionSize: number;
        maxOpenOrders: number;
        pollIntervalMs: number;
        trendWindowSeconds: number;
        orderCooldownMs: number;
        minSecondsBeforeExpiry: number;
        /** Don't trade when more than this many seconds remain — too much uncertainty. */
        maxSecondsBeforeExpiry: number;
        /** BTC must be at least this % past the strike before entering (filters noise crosses). */
        displacementThresholdPct: number;
        /** Exit when position is profitable by this many cents (flat TP). Set to 0 to disable. */
        takeProfitCents: number;
        /** Exit when trade P&L reaches this fraction of cost basis (proportional TP). e.g. 0.10 = +10%. Set to 0 to disable. */
        takeProfitPct: number;
        /** Exit when position is underwater by this many cents. */
        stopLossCents: number;
        balanceFractionPerTrade: number;
        /** After placing a limit exit, wait this long (live only); if still exposed, cancel limit and use market sells. */
        exitLimitGraceMs: number;
        /** Max time in pending exit phase before canceling and HOLD (safety net). */
        exitWaitTimeoutMs: number;
        syntheticUnderlyingAlpha: number;
        demoKalshiUnderlyingDollars: number;
    };
    dryRun: boolean;
    paperBalanceCents: number;
}
export declare const config: Config;
//# sourceMappingURL=config.d.ts.map