import type { KalshiMarket } from './types.js';
/** Kalshi FixedPointDollars / numeric contract price → float dollars */
export declare function parseFixedPointDollars(v: unknown): number | undefined;
/** Convert YES/NO price in [0,1] dollars to whole cents (0–100). */
export declare function contractDollarsToCents(d: number): number;
export declare function isPlausibleBtcUsd(price: number): boolean;
/**
 * Kalshi `last_price_dollars` is usually the last traded **YES contract** price in ~0–1 USD,
 * not spot BTC. Only treat as BTC index when in a plausible spot range.
 */
export declare function parseUnderlyingBtcFromLastPriceField(raw: unknown): number | undefined;
/**
 * Pre-settlement markets often have empty `expiration_value`; use strike fields.
 */
export declare function resolveExpirationValueDollars(m: Record<string, unknown>): number | undefined;
/**
 * Map current API lifecycle values to the subset the bot treats as tradable.
 */
export declare function normalizeTradableStatus(raw: string): KalshiMarket['status'];
export declare function buildKalshiMarketFromRaw(m: Record<string, unknown>): KalshiMarket;
//# sourceMappingURL=marketNormalize.d.ts.map