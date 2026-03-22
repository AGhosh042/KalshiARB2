import logger from '../utils/logger.js';
import { config } from '../config.js';
import { KalshiClient } from '../kalshi/client.js';
import { isPlausibleBtcUsd } from '../kalshi/marketNormalize.js';
import type { CoinbasePriceData } from '../coinbase/client.js';
import type { KalshiMarket, KalshiOrderRequest } from '../kalshi/types.js';

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
  // Trade details (only set on non-hold decisions).
  tradeKind?: 'entry' | 'exit';
  orderAction?: 'buy' | 'sell';
  side?: 'yes' | 'no';
  count?: number;
  limitPriceCents?: number;
}

export class ArbStrategy {
  private lastOrderTime = 0;
  private openOrderIds: string[] = [];
  private lastMarketTicker: string | null = null;
  private prevCoinbasePrice: number | null = null;
  private prevKalshiUnderlyingPriceDollars: number | null = null;
  private peakCoinbase: number | null = null;
  private troughCoinbase: number | null = null;

  // Latest observed prices (useful for dashboards/diagnostics).
  private lastCoinbasePriceDollars: number | null = null;
  private lastKalshiUnderlyingPriceDollars: number | null = null;
  private lastTargetPriceDollars: number | null = null;

  private lastCrossDirection: 'up' | 'down' | null = null;
  private lastCrossAtMs: number | null = null;

  // Exit TP that has been armed by the most recent reversal cross.
  private armedTpExitLimitCents: number | null = null;
  private armedTpExitSide: 'yes' | 'no' | null = null;

  // Current trade accounting (for dashboard “P/L of the trade”).
  // We approximate entry fills at the entry order limit price.
  private currentTradeSide: 'yes' | 'no' | null = null;
  private currentTradeEntryLimitCents: number | null = null;
  private currentTradeCount: number | null = null;
  private currentTradePnLCents: number | null = null;
  private currentTradePnLMode: 'unrealized' | 'realized' | null = null;

  // Debug: current tick comparison and direction.
  private lastCoinbaseDirection: 'up' | 'down' | 'flat' | null = null;
  private lastCoinbaseMinusUnderlyingDollars: number | null = null;

  // Last evaluated Coinbase price — used in placeEntryOrder for edge calculation.
  private lastEvaluatedCoinbasePrice: number | null = null;

  // Momentum EMAs (tick-based, not time-based — each Coinbase price update is one tick).
  // alpha5 ≈ fast (tracks last ~5 ticks), alpha20 ≈ slow (tracks last ~20 ticks).
  private ema5s: number | null = null;
  private ema20s: number | null = null;
  private prevEma5s: number | null = null;   // EMA5 from the previous tick — used for cross detection
  private prevEma20s: number | null = null;  // EMA20 from the previous tick — used for cross detection
  private static readonly EMA5_ALPHA = 2 / (5 + 1);   // 0.333
  private static readonly EMA20_ALPHA = 2 / (20 + 1);  // 0.095

  // Regime filter: track strike crossings within a rolling window.
  private crossTimestamps: number[] = [];
  private static readonly REGIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly REGIME_MAX_CROSSES = 3;
  private regimePausedUntilMs = 0;

  // Sequential exit-then-entry state machine:
  // - phase='exit' waits for the exit order to fully flatten position to 0.
  // - phase='entry' waits for the entry order to reach the target side.
  private pendingSide: 'long' | 'short' | null = null;
  private pendingPhase: 'exit' | 'entry' | null = null;
  private pendingExitOrderId: string | null = null;
  private pendingSinceMs: number | null = null;
  /** Live: after EXIT_LIMIT_GRACE_MS, limit exit was canceled and we are flattening with market sells. */
  private exitEscalatedToMarket = false;

  // Used only in DRY_RUN mode so we can still simulate sequential state.
  private simulatedPositionContracts = 0;

  // Position cache: avoid calling getPositions() on every Coinbase tick (reduces dropped ticks).
  private cachedPositionContracts = 0;
  private lastPositionFetchMs = 0;
  private static readonly POSITION_CACHE_TTL_MS = 500;

  /** When API omits a BTC-scale Kalshi index, EMA-smooth Coinbase to approximate lagged underlying. */
  private syntheticKalshiUnderlyingDollars: number | null = null;
  private warnedExpirationFallbackForTicker: string | null = null;

  // Demo-mode account tracking (only meaningful when `config.dryRun` is true).
  private demoStartingCashCents: number = config.paperBalanceCents;
  private demoCashCents: number = config.paperBalanceCents;

  // When true, close any open position as soon as bid >= entry price (breakeven or better).
  private closeAtBreakevenEnabled = false;

  constructor(private readonly kalshiClient: KalshiClient) {}

  setCloseAtBreakeven(enabled: boolean): void {
    this.closeAtBreakevenEnabled = enabled;
    logger.info('Close-at-breakeven', { enabled });
  }

  isCloseAtBreakevenEnabled(): boolean {
    return this.closeAtBreakevenEnabled;
  }

  getDemoStartingCashCents(): number {
    return this.demoStartingCashCents;
  }

  getDemoCashCents(): number {
    return this.demoCashCents;
  }

  getDemoPositionContracts(): number {
    return this.simulatedPositionContracts;
  }

  getLastCrossDirection(): 'up' | 'down' | null {
    return this.lastCrossDirection;
  }

  getLastCrossAtMs(): number | null {
    return this.lastCrossAtMs;
  }

  getArmedTpExitLimitCents(): number | null {
    return this.armedTpExitLimitCents;
  }

  getArmedTpExitSide(): 'yes' | 'no' | null {
    return this.armedTpExitSide;
  }

  getLastCoinbaseDirection(): 'up' | 'down' | 'flat' | null {
    return this.lastCoinbaseDirection;
  }

  getLastCoinbaseMinusUnderlyingDollars(): number | null {
    return this.lastCoinbaseMinusUnderlyingDollars;
  }

  getLastObservedCoinbasePriceDollars(): number | null {
    return this.lastCoinbasePriceDollars;
  }

  getLastObservedKalshiUnderlyingPriceDollars(): number | null {
    return this.lastKalshiUnderlyingPriceDollars;
  }

  getLastTargetPriceDollars(): number | null {
    return this.lastTargetPriceDollars;
  }

  getPendingPhase(): 'exit' | 'entry' | null {
    return this.pendingPhase;
  }

  getPendingSide(): 'long' | 'short' | null {
    return this.pendingSide;
  }

  getCurrentTradeSide(): 'yes' | 'no' | null {
    return this.currentTradeSide;
  }

  getCurrentTradeEntryLimitCents(): number | null {
    return this.currentTradeEntryLimitCents;
  }

  getCurrentTradeCount(): number | null {
    return this.currentTradeCount;
  }

  getCurrentTradePnLCents(): number | null {
    return this.currentTradePnLCents;
  }

  getCurrentTradePnLMode(): 'unrealized' | 'realized' | null {
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
  private computeTheoreticalYesProb(priceChangePct: number): number {
    const raw = 50 + (priceChangePct / 0.1) * 15;
    return Math.max(20, Math.min(80, raw));
  }

  /**
   * Computes the Kalshi implied YES probability from mid-market price.
   * mid = (yes_bid + yes_ask) / 2
   */
  private computeImpliedYesProb(market: KalshiMarket): number {
    if (market.yes_bid === 0 && market.yes_ask === 0) return 50;
    return (market.yes_bid + market.yes_ask) / 2;
  }

  /**
   * Returns the number of seconds until the market closes.
   */
  private secondsUntilClose(market: KalshiMarket): number {
    const closeMs = new Date(market.close_time).getTime();
    const nowMs = Date.now();
    return Math.max(0, (closeMs - nowMs) / 1000);
  }

  /**
   * Determines the position size in contracts.
   * min(MAX_POSITION_SIZE, floor(balance * balanceFractionPerTrade / askPriceInDollars))
   */
  private computePositionSize(balanceCents: number, askPriceCents: number, edgeCents?: number): number {
    // Dynamic sizing: scale position by edge magnitude relative to a reference edge of 10c.
    // Low edge (7c) → 70% of base size. High edge (20c) → 200% (capped by maxPositionSize).
    const baseFraction = config.strategy.balanceFractionPerTrade;
    const edgeMultiplier = edgeCents !== undefined
      ? Math.min(2.0, Math.max(0.5, edgeCents / 10))
      : 1.0;
    const fractionBalance = balanceCents * baseFraction * edgeMultiplier;
    const maxFromBalance = Math.floor(fractionBalance / askPriceCents);
    return Math.max(1, Math.min(config.strategy.maxPositionSize, maxFromBalance));
  }

  /**
   * Guard against empty books: when Kalshi has no contracts on either side,
   * prices are often 0/0 for that side and we should avoid placing any orders.
   */
  private isOrderbookUnavailable(market: KalshiMarket): boolean {
    const yesUnavailable = market.yes_bid <= 0 && market.yes_ask <= 0;
    const noUnavailable = market.no_bid <= 0 && market.no_ask <= 0;
    return yesUnavailable || noUnavailable;
  }

  /**
   * Refreshes the open order list by querying Kalshi and reconciling with
   * our tracked list.
   */
  private async refreshOpenOrders(ticker: string): Promise<void> {
    try {
      const openOrders = await this.kalshiClient.getOpenOrders(ticker);
      this.openOrderIds = openOrders.map((o) => o.order_id);
    } catch (err) {
      logger.warn('Could not refresh open orders', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fill missing `expiration_value` / BTC index from API quirks: empty expiration before settlement,
   * `last_price_dollars` as YES contract price (0–1) instead of spot. Mutates `market`.
   */
  private applyMarketFieldEnrichment(market: KalshiMarket, coinbasePrice: number): void {
    const exp = market.expiration_value_dollars;
    if (exp === undefined || Number.isNaN(exp) || exp <= 0) {
      market.expiration_value_dollars = config.strategy.referencePriceDollars;
      if (this.warnedExpirationFallbackForTicker !== market.ticker) {
        this.warnedExpirationFallbackForTicker = market.ticker;
        logger.warn(
          'Kalshi strike/expiration_value still unavailable after API normalization — using KALSHI_REFERENCE_PRICE_DOLLARS',
          { ticker: market.ticker, referencePriceDollars: config.strategy.referencePriceDollars }
        );
      }
    }

    const apiUnderlying = market.last_price_dollars;
    if (apiUnderlying !== undefined && isPlausibleBtcUsd(apiUnderlying)) {
      this.syntheticKalshiUnderlyingDollars = apiUnderlying;
      return;
    }

    const alpha = config.strategy.syntheticUnderlyingAlpha;
    const prev = this.syntheticKalshiUnderlyingDollars ?? coinbasePrice;
    const next = prev + alpha * (coinbasePrice - prev);
    this.syntheticKalshiUnderlyingDollars = next;
    market.last_price_dollars = next;

    if (apiUnderlying !== undefined && apiUnderlying <= 1.5) {
      logger.debug('Kalshi last_price_dollars is contract-scale; using synthetic lagged BTC index', {
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
  async evaluate(
    coinbaseData: CoinbasePriceData,
    market: KalshiMarket
  ): Promise<EvaluationResult> {
    // If we rotated to a different market ticker, reset internal cross/TP tracking
    // so we don't form crosses using stale underlyings.
    if (this.lastMarketTicker !== market.ticker) {
      this.lastMarketTicker = market.ticker;
      this.prevCoinbasePrice = null;
      this.prevKalshiUnderlyingPriceDollars = null;
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

    logger.debug('Strategy evaluation', {
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
    if (secsLeft < config.strategy.minSecondsBeforeExpiry) {
      return this.hold(`Market closes in ${secsLeft.toFixed(0)}s — too close to expiry`);
    }
    // --- Guard: Must not have too much time remaining (weak signal, uncertain) ---
    if (secsLeft > config.strategy.maxSecondsBeforeExpiry) {
      return this.hold(`Market closes in ${secsLeft.toFixed(0)}s — too far from expiry (max ${config.strategy.maxSecondsBeforeExpiry}s)`);
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
      return this.hold(
        `Orderbook unavailable (yes ${market.yes_bid}/${market.yes_ask}, no ${market.no_bid}/${market.no_ask})`
      );
    }

    const prevPrice = this.prevCoinbasePrice;
    const prevKalshiUnderlyingPriceDollars = this.prevKalshiUnderlyingPriceDollars;
    // Always advance the stored previous price so cross detection uses the last tick,
    // even when we return early during pending phases.
    this.prevCoinbasePrice = coinbasePrice;
    this.prevKalshiUnderlyingPriceDollars = kalshiUnderlyingPriceDollars;

    // Get current position exposure.
    // Cache the result for POSITION_CACHE_TTL_MS to avoid an async API call on every Coinbase
    // tick — getPositions() takes ~100-300ms and would cause isEvaluating to block every tick.
    let positionContracts = 0;
    if (config.dryRun) {
      positionContracts = this.simulatedPositionContracts;
    } else {
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
    } else {
      this.ema5s = this.ema5s + ArbStrategy.EMA5_ALPHA * (coinbasePrice - this.ema5s);
      this.ema20s = this.ema20s + ArbStrategy.EMA20_ALPHA * (coinbasePrice - this.ema20s);
    }

    // Update current-trade unrealized P/L mark-to-market (based on mid prices).
    // This is only meaningful when we have entry info stored.
    if (!isFlat && this.currentTradeEntryLimitCents !== null && this.currentTradeCount !== null) {
      const sideHeld: 'yes' | 'no' = isLong ? 'yes' : 'no';
      const entryLimit = this.currentTradeEntryLimitCents;
      const count = Math.max(0, this.currentTradeCount);
      const midCents = sideHeld === 'yes' ? (market.yes_bid + market.yes_ask) / 2 : (market.no_bid + market.no_ask) / 2;

      this.currentTradeSide = sideHeld;
      this.currentTradePnLCents = Math.round(count * (midCents - entryLimit));
      this.currentTradePnLMode = 'unrealized';
    } else if (isFlat) {
      // If we're flat, we keep whatever realized P/L was computed at the exit fill.
      if (positionContracts === 0) {
        // no-op
      }
    }

    // --- Breakeven close: if enabled, exit whenever bid >= entry price ---
    if (
      this.closeAtBreakevenEnabled &&
      !isFlat &&
      !this.pendingPhase &&
      this.currentTradeEntryLimitCents !== null
    ) {
      const sideHeld: 'yes' | 'no' = isLong ? 'yes' : 'no';
      const bid = isLong ? market.yes_bid : market.no_bid;
      if (bid >= this.currentTradeEntryLimitCents) {
        logger.info('Breakeven close triggered', {
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
          if (
            this.currentTradeEntryLimitCents !== null &&
            this.currentTradeCount !== null &&
            this.armedTpExitLimitCents !== null &&
            this.currentTradePnLCents !== null
          ) {
            const realized = this.currentTradeCount * (this.armedTpExitLimitCents - this.currentTradeEntryLimitCents);
            this.currentTradePnLCents = Math.round(realized);
            this.currentTradePnLMode = 'realized';
          }

          this.armedTpExitLimitCents = null;
          this.armedTpExitSide = null;

          const entryRes =
            this.pendingSide === 'long'
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

          if (elapsed > config.strategy.exitWaitTimeoutMs) {
            // Do not abandon a live open position; force/continue emergency flatten.
            if (!config.dryRun && positionContracts !== 0) {
              if (this.pendingExitOrderId) {
                try {
                  await this.kalshiClient.cancelOrder(this.pendingExitOrderId);
                } catch (err) {
                  logger.warn('Failed to cancel pending exit order on timeout', {
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
              const exitSide: 'yes' | 'no' = freshContracts > 0 ? 'yes' : 'no';
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
              return this.hold(
                `Emergency flatten retry after pending-exit timeout (${(elapsed / 1000).toFixed(0)}s): ${marketRes.reason}`
              );
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
          if (
            !config.dryRun &&
            positionContracts !== 0 &&
            elapsed >= config.strategy.exitLimitGraceMs
          ) {
            if (!this.exitEscalatedToMarket) {
              if (this.pendingExitOrderId) {
                try {
                  await this.kalshiClient.cancelOrder(this.pendingExitOrderId);
                } catch (err) {
                  logger.warn('Failed to cancel pending exit limit before market flatten', {
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
            const exitSide: 'yes' | 'no' = freshContracts > 0 ? 'yes' : 'no';
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

        return this.hold(
          `Waiting for exit fill: position=${positionContracts} pendingSide=${this.pendingSide}`
        );
      }

      // Phase 2: wait for entry fill (move to the target side).
      if (this.pendingPhase === 'entry') {
        const targetLong = this.pendingSide === 'long';
        const reached =
          (targetLong && positionContracts > 0) || (!targetLong && positionContracts < 0);

        if (reached) {
          // Reset extremum tracking for the new leg.
          this.pendingPhase = null;
          this.pendingSide = null;
          this.pendingExitOrderId = null;
          this.pendingSinceMs = null;

          if (targetLong) {
            this.peakCoinbase = coinbasePrice;
            this.troughCoinbase = null;
          } else {
            this.troughCoinbase = coinbasePrice;
            this.peakCoinbase = null;
          }

          return this.hold('Entry filled; TP tracking resumed');
        }

        // Safety timeout: if entry never fills, release the state machine so new crosses
        // can be traded on the next cycle instead of hanging forever.
        if (this.pendingSinceMs !== null) {
          const elapsed = Date.now() - this.pendingSinceMs;
          if (elapsed > config.strategy.exitWaitTimeoutMs) {
            logger.warn('Pending entry timed out — releasing state machine', {
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

        return this.hold(
          `Waiting for entry fill: position=${positionContracts} pendingSide=${this.pendingSide}`
        );
      }
    }

    // --- TP / SL / TTE exits: check before cross detection ---
    const tpslExit = await this.checkProfitAndLossExits(market, coinbasePrice, positionContracts, targetPriceDollars, secsLeft);
    if (tpslExit) return tpslExit;

    // --- Need a previous tick to detect EMA crossovers ---
    if (prevPrice === null || this.prevEma5s === null || this.prevEma20s === null) {
      if (isLong) {
        this.peakCoinbase = coinbasePrice;
      } else if (isShort) {
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
    const crossUp   = this.prevEma5s < this.prevEma20s && this.ema5s! >= this.ema20s!;
    const crossDown = this.prevEma5s > this.prevEma20s && this.ema5s! <= this.ema20s!;

    // Dashboard: show coinbase vs kalshi underlying diff (informational only, not used for signal)
    const currDiff = coinbasePrice - kalshiUnderlyingPriceDollars;
    this.lastCoinbaseMinusUnderlyingDollars = currDiff;
    this.lastCoinbaseDirection = rising ? 'up' : falling ? 'down' : 'flat';

    logger.debug('EMA cross check', {
      ema5s: this.ema5s!.toFixed(2),
      ema20s: this.ema20s!.toFixed(2),
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
        // Too many crosses in the window — market is choppy, pause for 2 minutes.
        logger.warn('Regime filter triggered — too many strike crosses, pausing 2 min', {
          crossCount: this.crossTimestamps.length,
          windowMs: ArbStrategy.REGIME_WINDOW_MS,
        });
        this.regimePausedUntilMs = Date.now() + 2 * 60 * 1000;
      }
    } else if (crossDown) {
      this.lastCrossDirection = 'down';
      this.lastCrossAtMs = Date.now();
      // Record cross for regime filter.
      this.crossTimestamps.push(Date.now());
      if (this.crossTimestamps.length > ArbStrategy.REGIME_MAX_CROSSES) {
        logger.warn('Regime filter triggered — too many strike crosses, pausing 2 min', {
          crossCount: this.crossTimestamps.length,
          windowMs: ArbStrategy.REGIME_WINDOW_MS,
        });
        this.regimePausedUntilMs = Date.now() + 2 * 60 * 1000;
      }
    }

    // --- Update extremum tracking while holding (not during pending phases) ---
    if (isLong) {
      this.peakCoinbase = this.peakCoinbase === null ? coinbasePrice : Math.max(this.peakCoinbase, coinbasePrice);
      this.troughCoinbase = null;
    } else if (isShort) {
      this.troughCoinbase = this.troughCoinbase === null ? coinbasePrice : Math.min(this.troughCoinbase, coinbasePrice);
      this.peakCoinbase = null;
    } else {
      this.peakCoinbase = null;
      this.troughCoinbase = null;
    }

    logger.debug('Cross detection', {
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
        if (entryRes.action === 'hold') return entryRes;

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
        if (entryRes.action === 'hold') return entryRes;

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
      if (exitRes.action === 'hold') return exitRes;

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
      if (exitRes.action === 'hold') return exitRes;

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

  private async canPlaceNewOrder(ticker: string): Promise<{ ok: boolean; reason?: string }> {
    const msSinceLastOrder = Date.now() - this.lastOrderTime;
    if (this.lastOrderTime > 0 && msSinceLastOrder < config.strategy.orderCooldownMs) {
      return {
        ok: false,
        reason: `Order cooldown active (${((config.strategy.orderCooldownMs - msSinceLastOrder) / 1000).toFixed(1)}s remaining)`,
      };
    }

    if (config.dryRun) return { ok: true };

    await this.refreshOpenOrders(ticker);
    if (this.openOrderIds.length >= config.strategy.maxOpenOrders) {
      return {
        ok: false,
        reason: `Too many open orders (${this.openOrderIds.length}/${config.strategy.maxOpenOrders})`,
      };
    }

    return { ok: true };
  }

  /**
   * Force-refresh position from the API (bypasses the 500ms cache) and return the net contract count.
   * Used before emergency flattens to ensure we don't sell more contracts than we actually hold.
   */
  private async fetchFreshPositionContracts(ticker: string): Promise<number> {
    const positions = await this.kalshiClient.getPositions();
    const contracts = positions.find((p) => p.ticker === ticker)?.position ?? 0;
    this.cachedPositionContracts = contracts;
    this.lastPositionFetchMs = Date.now();
    return contracts;
  }

  /** Like `canPlaceNewOrder` but skips cooldown so market flatten can run right after a limit exit. */
  private async canPlaceExitFlattenOrder(ticker: string): Promise<{ ok: boolean; reason?: string }> {
    if (config.dryRun) return { ok: true };

    await this.refreshOpenOrders(ticker);
    if (this.openOrderIds.length >= config.strategy.maxOpenOrders) {
      return {
        ok: false,
        reason: `Too many open orders (${this.openOrderIds.length}/${config.strategy.maxOpenOrders})`,
      };
    }

    return { ok: true };
  }

  /**
   * Best-effort cancel of all tracked open orders before emergency flatten,
   * so market exits are not blocked by max-open-order limits.
   */
  private async cancelTrackedOpenOrdersForFlatten(): Promise<void> {
    if (config.dryRun || this.openOrderIds.length === 0) return;

    const ids = [...new Set(this.openOrderIds)];
    for (const orderId of ids) {
      try {
        await this.kalshiClient.cancelOrder(orderId);
      } catch (err) {
        logger.warn('Failed to cancel tracked order during emergency flatten', {
          orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.openOrderIds = [];
  }

  private applySimulatedOrder(side: 'yes' | 'no', action: 'buy' | 'sell', count: number): void {
    // net contracts representation:
    //   position > 0: net YES
    //   position < 0: net NO
    if (action === 'buy' && side === 'yes') this.simulatedPositionContracts += count;
    else if (action === 'buy' && side === 'no') this.simulatedPositionContracts -= count;
    else if (action === 'sell' && side === 'yes') this.simulatedPositionContracts -= count;
    else if (action === 'sell' && side === 'no') this.simulatedPositionContracts += count;
  }

  private clamp(n: number, lo: number, hi: number): number {
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
  private coinbaseToYesLimitCents(coinbasePriceDollars: number, strikeDollars: number): number {
    const strike = strikeDollars;
    const deltaPct = ((coinbasePriceDollars - strike) / strike) * 100;
    const theoreticalYesProb = this.computeTheoreticalYesProb(deltaPct); // 20..80
    return this.clamp(Math.round(theoreticalYesProb), 1, 99);
  }

  private coinbaseToNoLimitCents(coinbasePriceDollars: number, strikeDollars: number): number {
    const yesLimitCents = this.coinbaseToYesLimitCents(coinbasePriceDollars, strikeDollars);
    // In a binary market, NO is typically the complement of YES.
    return this.clamp(100 - yesLimitCents, 1, 99);
  }

  private async placeEntryOrder(market: KalshiMarket, side: 'yes' | 'no'): Promise<EvaluationResult> {
    if (this.isOrderbookUnavailable(market)) {
      return this.hold('Orderbook unavailable — entry blocked');
    }
    const can = await this.canPlaceNewOrder(market.ticker);
    if (!can.ok) return this.hold(can.reason ?? 'Cannot place entry order');

    const askPriceCents = side === 'yes' ? market.yes_ask : market.no_ask;
    const bidPriceCents = side === 'yes' ? market.yes_bid : market.no_bid;

    // Edge check: ensure Kalshi hasn't already repriced before we enter.
    // Fair value is computed from Coinbase displacement vs strike using the same sigmoid used for orders.
    const strikeDollars = market.expiration_value_dollars ?? config.strategy.referencePriceDollars;
    const coinbasePrice = this.lastEvaluatedCoinbasePrice ?? strikeDollars;
    const fairValueYesCents = this.coinbaseToYesLimitCents(coinbasePrice, strikeDollars);
    const fairValueCents = side === 'yes' ? fairValueYesCents : (100 - fairValueYesCents);
    const spread = askPriceCents - bidPriceCents;
    // Required edge must cover the spread plus a profit buffer.
    const requiredEdge = Math.max(config.strategy.kalshiEdgeThreshold, spread + 3);
    const edge = fairValueCents - askPriceCents;
    if (edge < requiredEdge) {
      logger.info('Edge check failed — Kalshi already repriced', {
        side, askPriceCents, fairValueCents, edge: edge.toFixed(1), requiredEdge: requiredEdge.toFixed(1), spread,
      });
      return this.hold(`Edge ${edge.toFixed(1)}c < required ${requiredEdge.toFixed(1)}c — market already repriced`);
    }
    const balanceCents = config.dryRun ? this.demoCashCents : await this.kalshiClient.getBalance();
    // Pass edge for dynamic sizing: higher edge → larger position (capped at maxPositionSize).
    const count = this.computePositionSize(balanceCents, askPriceCents, edge);

    if (count < 1) {
      return this.hold(
        `Insufficient balance for entry (balance: ${balanceCents} cents, ask: ${askPriceCents} cents)`
      );
    }

    const orderReq: KalshiOrderRequest = {
      ticker: market.ticker,
      side,
      count,
      action: 'buy',
      type: 'limit',
      ...(side === 'yes' ? { yes_price: askPriceCents } : { no_price: askPriceCents }),
    };

    const action = side === 'yes' ? 'buy_yes' : 'buy_no';
    const totalCostDollars = (count * askPriceCents) / 100;

    if (config.dryRun) {
      logger.info('[DRY RUN] Would place ENTRY order', {
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

      logger.info('Placed Kalshi ENTRY order', {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to place Kalshi ENTRY order', { error: msg, side, count, askPriceCents });
      return this.hold(`Entry placement failed: ${msg}`);
    }
  }

  private async placeExitOrder(
    market: KalshiMarket,
    side: 'yes' | 'no',
    count: number,
    limitPriceCents: number
  ): Promise<EvaluationResult> {
    if (this.isOrderbookUnavailable(market)) {
      return this.hold('Orderbook unavailable — exit blocked');
    }
    const can = await this.canPlaceNewOrder(market.ticker);
    if (!can.ok) return this.hold(can.reason ?? 'Cannot place exit order');

    if (count < 1) {
      return this.hold(`Invalid exit count: ${count}`);
    }

    const orderReq: KalshiOrderRequest = {
      ticker: market.ticker,
      side,
      count,
      action: 'sell',
      type: 'ioc',        // Kalshi requires IoC when reduce_only is set
      reduce_only: true,  // tells Kalshi this closes an existing position — no margin required
      ...(side === 'yes' ? { yes_price: limitPriceCents } : { no_price: limitPriceCents }),
    };

    const action = side === 'yes' ? 'sell_yes' : 'sell_no';
    const totalDollars = (count * limitPriceCents) / 100;

    if (config.dryRun) {
      logger.info('[DRY RUN] Would place EXIT order', {
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

      logger.info('Placed Kalshi EXIT order', {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to place Kalshi EXIT order', { error: msg, side, count, limitPriceCents });
      return this.hold(`Exit placement failed: ${msg}`);
    }
  }

  private async placeMarketExitOrder(
    market: KalshiMarket,
    side: 'yes' | 'no',
    count: number
  ): Promise<EvaluationResult> {
    if (this.isOrderbookUnavailable(market)) {
      return this.hold('Orderbook unavailable — market exit blocked');
    }
    const can = await this.canPlaceExitFlattenOrder(market.ticker);
    if (!can.ok) return this.hold(can.reason ?? 'Cannot place market exit order');

    if (count < 1) {
      return this.hold(`Invalid market exit count: ${count}`);
    }

    // Kalshi does not support true market orders — a price is always required.
    // Use the current bid as the limit price. This fills immediately against resting bids
    // and avoids the margin Kalshi charges when the price is far from market (e.g. 1¢ sell
    // causes Kalshi to reserve 99¢/contract margin as if it were a new short).
    const bid = side === 'yes' ? market.yes_bid : market.no_bid;
    const aggressivePriceCents = Math.max(bid, 1);
    const orderReq: KalshiOrderRequest = {
      ticker: market.ticker,
      side,
      count,
      action: 'sell',
      type: 'ioc',        // Kalshi requires IoC when reduce_only is set
      reduce_only: true,  // tells Kalshi this closes an existing position — no margin required
      ...(side === 'yes' ? { yes_price: aggressivePriceCents } : { no_price: aggressivePriceCents }),
    };

    const action = side === 'yes' ? 'sell_yes' : 'sell_no';

    if (config.dryRun) {
      logger.info('[DRY RUN] Would place MARKET EXIT order (aggressive limit @ 1¢)', {
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

      logger.info('Placed Kalshi MARKET EXIT order (aggressive limit @ 1¢)', {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to place Kalshi MARKET EXIT order', { error: msg, side, count });
      return this.hold(`Market exit placement failed: ${msg}`);
    }
  }

  /**
   * Checks TP, SL, and TTE-based exits. Returns an exit result if we should close,
   * null if position should be held or there's nothing to do.
   * Called before cross detection so exits fire on every tick.
   */
  private async checkProfitAndLossExits(
    market: KalshiMarket,
    coinbasePrice: number,
    positionContracts: number,
    targetPriceDollars: number,
    secsLeft: number,
  ): Promise<EvaluationResult | null> {
    const isLong = positionContracts > 0;
    const isShort = positionContracts < 0;
    if (!isLong && !isShort) return null;
    if (this.pendingPhase) return null;
    if (this.currentTradeEntryLimitCents === null) return null;

    const heldSide: 'yes' | 'no' = isLong ? 'yes' : 'no';
    const bid = heldSide === 'yes' ? market.yes_bid : market.no_bid;
    const entry = this.currentTradeEntryLimitCents;
    const count = Math.abs(positionContracts);
    const pnlCents = bid - entry;

    // Take profit: Kalshi has repriced in our favor by takeProfitCents.
    if (pnlCents >= config.strategy.takeProfitCents) {
      logger.info('TAKE PROFIT triggered', { heldSide, bid, entry, pnlCents });
      return await this.placeMarketExitOrder(market, heldSide, count);
    }

    // Stop loss: underwater by stopLossCents at any time.
    if (pnlCents <= -config.strategy.stopLossCents) {
      logger.info('STOP LOSS triggered', { heldSide, bid, entry, pnlCents });
      return await this.placeMarketExitOrder(market, heldSide, count);
    }

    // Near expiry (<3 min): hold if winning, cut if losing.
    if (secsLeft < 180) {
      const btcAboveStrike = coinbasePrice > targetPriceDollars;
      const positionIsWinning = (isLong && btcAboveStrike) || (isShort && !btcAboveStrike);

      if (!positionIsWinning && pnlCents < -3) {
        logger.info('Near-expiry cut-loss triggered', { secsLeft: secsLeft.toFixed(0), heldSide, btcAboveStrike, pnlCents });
        return await this.placeMarketExitOrder(market, heldSide, count);
      }
      if (positionIsWinning) {
        // Hold to expiry — let theta work for us.
        return this.hold(`Near expiry, holding winner (${secsLeft.toFixed(0)}s left, ${pnlCents >= 0 ? '+' : ''}${pnlCents}c)`);
      }
    }

    // Thesis failure: still losing with <5 min left.
    if (secsLeft < 300 && pnlCents < -5) {
      logger.info('Thesis-failure exit triggered', { secsLeft: secsLeft.toFixed(0), pnlCents });
      return await this.placeMarketExitOrder(market, heldSide, count);
    }

    return null;
  }

  private hold(reason: string): EvaluationResult {
    return { action: 'hold', reason };
  }

  /**
   * Cancel all tracked open orders. Called on shutdown.
   */
  async cancelAllOpenOrders(): Promise<void> {
    if (this.openOrderIds.length === 0) {
      logger.info('No open orders to cancel');
      return;
    }

    logger.info(`Cancelling ${this.openOrderIds.length} open order(s)...`);
    const ids = [...this.openOrderIds];

    for (const orderId of ids) {
      try {
        await this.kalshiClient.cancelOrder(orderId);
        this.openOrderIds = this.openOrderIds.filter((id) => id !== orderId);
      } catch (err) {
        logger.warn('Failed to cancel order on shutdown', {
          orderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  getOpenOrderIds(): string[] {
    return [...this.openOrderIds];
  }
}
