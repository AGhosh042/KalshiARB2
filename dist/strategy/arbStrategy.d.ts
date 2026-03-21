import { KalshiClient } from '../kalshi/client.js';
import type { CoinbasePriceData } from '../coinbase/client.js';
import type { KalshiMarket } from '../kalshi/types.js';
export interface EvaluationResult {
    action: 'buy_yes' | 'buy_no' | 'sell_yes' | 'sell_no' | 'hold';
    reason: string;
    orderId?: string;
    coinbasePrice?: number;
    referencePriceDollars?: number;
    kalshiUnderlyingPriceDollars?: number;
    recordedPeak?: number;
    recordedTrough?: number;
    exitLimitCents?: number;
    pendingPhase?: 'exit' | 'entry' | null;
    pendingSide?: 'long' | 'short' | null;
    tradeKind?: 'entry' | 'exit';
    orderAction?: 'buy' | 'sell';
    side?: 'yes' | 'no';
    count?: number;
    limitPriceCents?: number;
}
export declare class ArbStrategy {
    private readonly kalshiClient;
    private lastOrderTime;
    private openOrderIds;
    private lastMarketTicker;
    private prevCoinbasePrice;
    private prevKalshiUnderlyingPriceDollars;
    private peakCoinbase;
    private troughCoinbase;
    private lastCoinbasePriceDollars;
    private lastKalshiUnderlyingPriceDollars;
    private lastTargetPriceDollars;
    private lastCrossDirection;
    private lastCrossAtMs;
    private armedTpExitLimitCents;
    private armedTpExitSide;
    private currentTradeSide;
    private currentTradeEntryLimitCents;
    private currentTradeCount;
    private currentTradePnLCents;
    private currentTradePnLMode;
    private lastCoinbaseDirection;
    private lastCoinbaseMinusUnderlyingDollars;
    private pendingSide;
    private pendingPhase;
    private pendingExitOrderId;
    private pendingSinceMs;
    /** Live: after EXIT_LIMIT_GRACE_MS, limit exit was canceled and we are flattening with market sells. */
    private exitEscalatedToMarket;
    private simulatedPositionContracts;
    private cachedPositionContracts;
    private lastPositionFetchMs;
    private static readonly POSITION_CACHE_TTL_MS;
    /** When API omits a BTC-scale Kalshi index, EMA-smooth Coinbase to approximate lagged underlying. */
    private syntheticKalshiUnderlyingDollars;
    private warnedExpirationFallbackForTicker;
    private demoStartingCashCents;
    private demoCashCents;
    private closeAtBreakevenEnabled;
    constructor(kalshiClient: KalshiClient);
    setCloseAtBreakeven(enabled: boolean): void;
    isCloseAtBreakevenEnabled(): boolean;
    getDemoStartingCashCents(): number;
    getDemoCashCents(): number;
    getDemoPositionContracts(): number;
    getLastCrossDirection(): 'up' | 'down' | null;
    getLastCrossAtMs(): number | null;
    getArmedTpExitLimitCents(): number | null;
    getArmedTpExitSide(): 'yes' | 'no' | null;
    getLastCoinbaseDirection(): 'up' | 'down' | 'flat' | null;
    getLastCoinbaseMinusUnderlyingDollars(): number | null;
    getLastObservedCoinbasePriceDollars(): number | null;
    getLastObservedKalshiUnderlyingPriceDollars(): number | null;
    getLastTargetPriceDollars(): number | null;
    getPendingPhase(): 'exit' | 'entry' | null;
    getPendingSide(): 'long' | 'short' | null;
    getCurrentTradeSide(): 'yes' | 'no' | null;
    getCurrentTradeEntryLimitCents(): number | null;
    getCurrentTradeCount(): number | null;
    getCurrentTradePnLCents(): number | null;
    getCurrentTradePnLMode(): 'unrealized' | 'realized' | null;
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
    private computeTheoreticalYesProb;
    /**
     * Computes the Kalshi implied YES probability from mid-market price.
     * mid = (yes_bid + yes_ask) / 2
     */
    private computeImpliedYesProb;
    /**
     * Returns the number of seconds until the market closes.
     */
    private secondsUntilClose;
    /**
     * Determines the position size in contracts.
     * min(MAX_POSITION_SIZE, floor(balance * balanceFractionPerTrade / askPriceInDollars))
     */
    private computePositionSize;
    /**
     * Guard against empty books: when Kalshi has no contracts on either side,
     * prices are often 0/0 for that side and we should avoid placing any orders.
     */
    private isOrderbookUnavailable;
    /**
     * Refreshes the open order list by querying Kalshi and reconciling with
     * our tracked list.
     */
    private refreshOpenOrders;
    /**
     * Fill missing `expiration_value` / BTC index from API quirks: empty expiration before settlement,
     * `last_price_dollars` as YES contract price (0–1) instead of spot. Mutates `market`.
     */
    private applyMarketFieldEnrichment;
    /**
     * Main evaluation method. Called on every poll cycle.
     * Determines whether to place a YES or NO order based on the edge between
     * Coinbase-implied probability and Kalshi market probability.
     */
    evaluate(coinbaseData: CoinbasePriceData, market: KalshiMarket): Promise<EvaluationResult>;
    private canPlaceNewOrder;
    /**
     * Force-refresh position from the API (bypasses the 500ms cache) and return the net contract count.
     * Used before emergency flattens to ensure we don't sell more contracts than we actually hold.
     */
    private fetchFreshPositionContracts;
    /** Like `canPlaceNewOrder` but skips cooldown so market flatten can run right after a limit exit. */
    private canPlaceExitFlattenOrder;
    /**
     * Best-effort cancel of all tracked open orders before emergency flatten,
     * so market exits are not blocked by max-open-order limits.
     */
    private cancelTrackedOpenOrdersForFlatten;
    private applySimulatedOrder;
    private clamp;
    /**
     * Map a Coinbase BTC price (in dollars) to a Kalshi YES limit price (0-100 cents).
     *
     * This reuses the repo's existing sigmoid-like approximation:
     *   theoretical_yes_prob = 50 + (deltaPct / 0.1) * 15, clamped to [20, 80]
     *
     * Where deltaPct = ((price - strike) / strike) * 100.
     */
    private coinbaseToYesLimitCents;
    private coinbaseToNoLimitCents;
    private placeEntryOrder;
    private placeExitOrder;
    private placeMarketExitOrder;
    private hold;
    /**
     * Cancel all tracked open orders. Called on shutdown.
     */
    cancelAllOpenOrders(): Promise<void>;
    getOpenOrderIds(): string[];
}
//# sourceMappingURL=arbStrategy.d.ts.map