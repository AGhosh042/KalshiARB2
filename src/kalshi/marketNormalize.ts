import type { KalshiMarket } from './types.js';

const MIN_PLAUSIBLE_BTC_USD = 1000;
const MAX_CONTRACT_LAST_TRADE_USD = 1.5;

function parseFiniteNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (s === '') return undefined;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Kalshi FixedPointDollars / numeric contract price → float dollars */
export function parseFixedPointDollars(v: unknown): number | undefined {
  return parseFiniteNumber(v);
}

/** Convert YES/NO price in [0,1] dollars to whole cents (0–100). */
export function contractDollarsToCents(d: number): number {
  const c = Math.round(d * 100);
  return Math.max(0, Math.min(100, c));
}

export function isPlausibleBtcUsd(price: number): boolean {
  return Number.isFinite(price) && price >= MIN_PLAUSIBLE_BTC_USD;
}

/**
 * Kalshi `last_price_dollars` is usually the last traded **YES contract** price in ~0–1 USD,
 * not spot BTC. Only treat as BTC index when in a plausible spot range.
 */
export function parseUnderlyingBtcFromLastPriceField(raw: unknown): number | undefined {
  const n = parseFixedPointDollars(raw);
  if (n === undefined) return undefined;
  if (n <= MAX_CONTRACT_LAST_TRADE_USD) return undefined;
  if (!isPlausibleBtcUsd(n)) return undefined;
  return n;
}

/**
 * Pre-settlement markets often have empty `expiration_value`; use strike fields.
 */
export function resolveExpirationValueDollars(m: Record<string, unknown>): number | undefined {
  const strikeType = String(m['strike_type'] ?? '');
  const floor = parseFiniteNumber(m['floor_strike']);
  const cap = parseFiniteNumber(m['cap_strike']);

  if (strikeType === 'greater' || strikeType === 'greater_or_equal') {
    if (floor !== undefined) return floor;
  }
  if (strikeType === 'less' || strikeType === 'less_or_equal') {
    if (cap !== undefined) return cap;
  }
  if (strikeType === 'between' && floor !== undefined && cap !== undefined) {
    return (floor + cap) / 2;
  }
  if (floor !== undefined && cap === undefined) return floor;
  if (cap !== undefined && floor === undefined) return cap;

  const rules = String(m['rules_primary'] ?? '');
  const match = rules.match(
    /(?:above|below|between)\s+([\d,]+(?:\.\d+)?)(?:\s*-\s*([\d,]+(?:\.\d+)?))?/i
  );
  if (match) {
    const a = parseFloat(match[1].replace(/,/g, ''));
    const b = match[2] ? parseFloat(match[2].replace(/,/g, '')) : undefined;
    if (Number.isFinite(a) && b !== undefined && Number.isFinite(b)) return (a + b) / 2;
    if (Number.isFinite(a)) return a;
  }

  return undefined;
}

/**
 * Map current API lifecycle values to the subset the bot treats as tradable.
 */
export function normalizeTradableStatus(raw: string): KalshiMarket['status'] {
  if (raw === 'active' || raw === 'open') return 'open';
  if (raw === 'settled' || raw === 'determined') return 'settled';
  if (raw === 'finalized') return 'finalized';
  return 'closed';
}

function parseExpirationValueField(m: Record<string, unknown>): number | undefined {
  const ev = m['expiration_value'];
  if (typeof ev === 'string' && ev.trim() !== '') {
    const n = parseFloat(ev.trim().replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof ev === 'number' && ev > 0) return ev;
  return undefined;
}

export function buildKalshiMarketFromRaw(m: Record<string, unknown>): KalshiMarket {
  const yesBidD = parseFixedPointDollars(m['yes_bid_dollars']);
  const yesAskD = parseFixedPointDollars(m['yes_ask_dollars']);
  const noBidD = parseFixedPointDollars(m['no_bid_dollars']);
  const noAskD = parseFixedPointDollars(m['no_ask_dollars']);

  const yes_bid =
    typeof m['yes_bid'] === 'number'
      ? m['yes_bid']
      : yesBidD !== undefined
        ? contractDollarsToCents(yesBidD)
        : 0;
  const yes_ask =
    typeof m['yes_ask'] === 'number'
      ? m['yes_ask']
      : yesAskD !== undefined
        ? contractDollarsToCents(yesAskD)
        : 0;
  const no_bid =
    typeof m['no_bid'] === 'number'
      ? m['no_bid']
      : noBidD !== undefined
        ? contractDollarsToCents(noBidD)
        : 0;
  const no_ask =
    typeof m['no_ask'] === 'number'
      ? m['no_ask']
      : noAskD !== undefined
        ? contractDollarsToCents(noAskD)
        : 0;

  const volFp = parseFiniteNumber(m['volume_fp']);
  const vol = typeof m['volume'] === 'number' ? m['volume'] : volFp ?? 0;
  const oiFp = parseFiniteNumber(m['open_interest_fp']);
  const oi = typeof m['open_interest'] === 'number' ? m['open_interest'] : oiFp ?? 0;

  const underlyingBtc = parseUnderlyingBtcFromLastPriceField(m['last_price_dollars']);
  const expiration_value_dollars =
    parseExpirationValueField(m) ?? resolveExpirationValueDollars(m);

  const rawStatus = String(m['status'] ?? 'closed');

  return {
    ticker: String(m['ticker'] ?? ''),
    yes_bid,
    yes_ask,
    no_bid,
    no_ask,
    last_price_dollars: underlyingBtc,
    expiration_value_dollars,
    volume: vol,
    open_interest: oi,
    status: normalizeTradableStatus(rawStatus),
    close_time: String(m['close_time'] ?? ''),
    result: (m['result'] as KalshiMarket['result']) ?? null,
  };
}
