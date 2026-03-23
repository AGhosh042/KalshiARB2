export type BotMode = 'live' | 'demo';
export interface TradeHistoryEntry {
    timestamp: number;
    tradeKind: 'entry' | 'exit';
    orderAction: 'buy' | 'sell';
    side: 'yes' | 'no';
    count: number;
    limitPriceCents: number;
    orderId?: string;
}
export interface DashboardState {
    mode: BotMode;
    running: boolean;
    startBalanceCents: number;
    currentBalanceCents: number;
    pnlCents: number;
    updatedAt: number;
    positionContracts: number;
    positionSide: 'long' | 'short' | 'flat';
    openOrdersCount: number;
    lastCrossDirection: 'up' | 'down' | null;
    lastCrossAtMs: number | null;
    armedTpExitLimitCents: number | null;
    armedTpExitSide: 'yes' | 'no' | null;
    lastCoinbasePriceDollars: number | null;
    lastKalshiUnderlyingPriceDollars: number | null;
    lastTargetPriceDollars: number | null;
    lastCoinbaseUpdateAtMs: number | null;
    lastKalshiUnderlyingUpdateAtMs: number | null;
    lastEvalAtMs: number | null;
    coinbaseMinusUnderlyingDollars: number | null;
    coinbaseMinusUnderlyingPct: number | null;
    coinbaseMinusUnderlyingSign: string | null;
    coinbaseDirection: 'up' | 'down' | 'flat' | null;
    currentTradeSide: 'yes' | 'no' | null;
    currentTradeEntryLimitCents: number | null;
    currentTradeCount: number | null;
    currentTradePnLCents: number | null;
    currentTradePnLMode: 'unrealized' | 'realized' | null;
    marketTicker?: string;
    breakevenCloseEnabled: boolean;
}
export declare class BotRunner {
    private coinbaseClient;
    private kalshiClient;
    private strategy;
    private latestCoinbaseData;
    private lastKalshiUnderlyingPriceDollars;
    private demoUnderlyingLastDollars;
    private demoTargetDollars;
    private lastCoinbaseUpdateAtMs;
    private lastKalshiUnderlyingUpdateAtMs;
    private lastEvalAtMs;
    private demoCoinbaseTimer;
    private demoCoinbaseStartAtMs;
    private demoCoinbasePriceDollars;
    private demoCoinbaseHistory;
    private buildDemoMarket;
    /**
     * Build the Kalshi ticker suffix from a close date.
     * Actual API format: {YY}{MON}{DD}{HHMM}-{MM}
     * e.g. close = 2026-03-20T21:45:00Z → "26MAR201745-45"
     */
    private formatTickerSuffix;
    private parseRotationMinutesFromPrefix;
    private isNotFoundMarketError;
    private buildTickerFromPrefixAndClose;
    /**
     * If the configured ticker has rolled over, try nearby rotation slots and switch
     * to the first market that resolves successfully.
     */
    private recoverLiveTickerOn404;
    private computeNextMarketTicker;
    private pollTimer;
    private balanceLogTimer;
    private isEvaluating;
    private latestMarket;
    private kalshiFetchLoopActive;
    private kalshiWsClient;
    private state;
    private trades;
    private startBalanceCents;
    private lastStateUpdateMs;
    private currentMarketTicker;
    getState(): DashboardState | null;
    setBreakevenClose(enabled: boolean): void;
    isBreakevenCloseEnabled(): boolean;
    getTrades(): TradeHistoryEntry[];
    start(mode: BotMode, theoreticalBalanceDollars: number, demoUnderlyingDollars?: number, demoTargetDollars?: number): Promise<void>;
    private maybeRecordTrade;
    private updateDashboardState;
    /**
     * At startup, query Kalshi for currently open markets in the configured series and
     * switch to the earliest-closing one. This means KALSHI_MARKET_TICKER only needs to
     * contain the series prefix (e.g. "kxbtc15m") — the exact contract is auto-discovered.
     */
    private initializeMarketTicker;
    /** Start real-time Kalshi market data via WebSocket (replaces REST polling loop). */
    private startKalshiWsFeed;
    private lastRotationCheckMs;
    /** Auto-rotate to the next open market (called when current market is near/past close). */
    private tryRotateMarketTicker;
    stop(): Promise<void>;
}
//# sourceMappingURL=botRunner.d.ts.map