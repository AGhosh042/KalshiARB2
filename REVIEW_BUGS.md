# KalshiARB2 — Bug Report
**Reviewer:** Senior Trading Systems Engineer  
**Date:** 2026-03-21  
**Subject:** Entry timing failures, dead config, and logic bugs  
**User complaint:** "I don't think it is entering at the right time."

---

## Summary

The bot has **one root cause that explains the entry timing complaint almost entirely**: cross detection is being run against a **fixed, hardcoded strike price** — not a live Kalshi index or the contract's actual reference price. Combined with a stale fallback value ($71,052 when BTC is nowhere near that), the bot will either never cross (if BTC is far from the strike) or will fire constantly on irrelevant levels. All other bugs compound this.

---

## Issues — Prioritized by Severity

---

### 🔴 CRITICAL — Issue #1: Cross Detection Uses Fixed Strike, Not Live Index

**Severity:** CRITICAL  
**File:** `src/strategy/arbStrategy.ts`

**Description:**  
The entire entry/exit signal is built around detecting when Coinbase BTC spot "crosses" a price level. That level is `market.expiration_value_dollars` — the **fixed dollar strike of the contract** (e.g., $85,000 for a "BTC above $85k?" market). This is not the Kalshi live index price; it is the static expiry threshold baked into the contract.

This means:
- If BTC is already well above the strike, `currDiff` is always positive — no crossUp ever fires, no crossDown ever fires. The bot sits flat forever.
- If BTC is well below the strike, same problem in reverse.
- The only time the bot enters is if BTC happens to be oscillating right around the contract's strike at the moment the bot is running — which is a narrow, random condition, not an arbitrage edge.

**Root cause:**  
```typescript
const kalshiUnderlyingPriceDollars = targetPriceDollars; // ← this is the strike, FIXED
```
The variable was intended to track where Kalshi's internal index/underlying is trading, but it was incorrectly assigned the static expiry strike instead of a live price.

**Exact fix:**  
Replace the fixed strike with the Kalshi live index price (fetched from the market's `index_price` or `last_price` field, or derived from the synthetic EMA that already exists but is unused):

```typescript
// BEFORE (wrong):
const kalshiUnderlyingPriceDollars = targetPriceDollars; // fixed strike

// AFTER (correct):
// Use the live Kalshi index if available, otherwise fall back to syntheticKalshiUnderlyingDollars
const kalshiUnderlyingPriceDollars =
  (market.index_price_dollars && market.index_price_dollars > 1000)
    ? market.index_price_dollars
    : this.syntheticKalshiUnderlyingDollars;
```

The cross detection should compare Coinbase spot vs. the **live Kalshi-implied BTC price**, not the contract's strike. The strike is used to determine YES/NO direction — not as the crossing level.

---

### 🔴 CRITICAL — Issue #2: Stale Hardcoded Fallback Price ($71,052)

**Severity:** CRITICAL  
**File:** `src/config.ts`

**Description:**  
When `market.expiration_value_dollars` is missing or invalid from the API, the bot falls back to `config.strategy.referencePriceDollars`, which defaults to **$71,052.06** — a stale price from a prior BTC trading range (circa late 2024). With BTC at a materially different level, this fallback will cause cross detection to fire or stall based on a phantom price level that has no relationship to current market structure.

**Root cause:**  
```typescript
referencePriceDollars: getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 71052.06), // ← stale default
```
Hardcoded default was never updated and is not sourced dynamically.

**Exact fix:**  
1. Remove the hardcoded default entirely. Force it to be set via env:
```typescript
referencePriceDollars: requireEnv('KALSHI_REFERENCE_PRICE_DOLLARS'), // must be set explicitly
```
2. Or, if a default must exist, seed it from the Coinbase WS price on startup — never a magic number. Add a startup check:
```typescript
if (config.strategy.referencePriceDollars < 10_000 || config.strategy.referencePriceDollars > 1_000_000) {
  throw new Error('KALSHI_REFERENCE_PRICE_DOLLARS appears stale or missing. Set it explicitly.');
}
```
3. Update `.env.example` to require `KALSHI_REFERENCE_PRICE_DOLLARS` to be set before launch.

---

### 🔴 CRITICAL — Issue #3: `kalshiEdgeThreshold` Is Defined but Never Enforced

**Severity:** CRITICAL (silent risk control failure)  
**File:** `src/config.ts`, `src/strategy/arbStrategy.ts`

**Description:**  
`kalshiEdgeThreshold` (default: 3 cents) is defined in config as if it were a minimum edge required before entering a trade. It is **never referenced anywhere in `arbStrategy.ts`**. The bot places orders without any edge check — it will enter even at zero edge or negative edge, generating guaranteed losses on every trade.

**Root cause:**  
The config key was defined but the guard was never wired into `placeEntryOrder`:
```typescript
// placeEntryOrder does NOT check kalshiEdgeThreshold before entering
```

**Exact fix:**  
Add an edge check in `placeEntryOrder` before placing the order:
```typescript
private async placeEntryOrder(market: KalshiMarket, side: 'yes' | 'no'): Promise<EvaluationResult> {
  const askPriceCents = side === 'yes' ? market.yes_ask : market.no_ask;
  const fairValueCents = this.computeFairValue(market, side); // your existing or new fair value calc
  const edgeCents = fairValueCents - askPriceCents;

  if (edgeCents < config.strategy.kalshiEdgeThreshold) {
    return { action: 'none', reason: `Insufficient edge: ${edgeCents}c < ${config.strategy.kalshiEdgeThreshold}c threshold` };
  }

  // ... proceed with order placement
}
```

---

### 🟠 HIGH — Issue #4: Synthetic Underlying EMA Is Computed but Never Used

**Severity:** HIGH  
**File:** `src/strategy/arbStrategy.ts`

**Description:**  
A synthetic EMA (`syntheticKalshiUnderlyingDollars`) is maintained to estimate where Kalshi's underlying BTC price is trading when the API doesn't return a plausible `last_price_dollars`. This is the correct architectural approach. However, it is **never plugged into cross detection** — cross detection always uses the fixed strike instead (see Issue #1).

The EMA is computed on every tick and then discarded. This is dead computation.

**Root cause:**  
The EMA was built as infrastructure for dynamic cross detection but was never connected to the signal generation path.

**Exact fix:**  
Wire `syntheticKalshiUnderlyingDollars` into the cross detection logic as the primary underlying price reference (see fix for Issue #1 above). This resolves both bugs simultaneously.

---

### 🟠 HIGH — Issue #5: `priceMoveThresholdPct` Is Defined but Never Enforced

**Severity:** HIGH  
**File:** `src/config.ts`, `src/strategy/arbStrategy.ts`

**Description:**  
`priceMoveThresholdPct` (default: 0.05%) is configured as a minimum price move required to trigger entry. It is **never checked in `placeEntryOrder`**. The bot will enter on any cross, no matter how small or noisy the price move that caused it.

**Root cause:**  
Same pattern as `kalshiEdgeThreshold` — config key exists, guard was never implemented.

**Exact fix:**  
Add a momentum filter before entry. Compute the price move that caused the cross and gate entry on it:
```typescript
const priceMoveAbs = Math.abs(currDiff - prevDiff);
const priceMoveThreshold = kalshiUnderlyingPriceDollars * (config.strategy.priceMoveThresholdPct / 100);

if (priceMoveAbs < priceMoveThreshold) {
  return { action: 'none', reason: 'Price move below threshold — likely noise' };
}
```

---

### 🟠 HIGH — Issue #6: Trend Signal Is Computed but Never Used

**Severity:** HIGH  
**File:** `src/coinbase/coinbaseClient.ts`, `src/strategy/arbStrategy.ts`

**Description:**  
The Coinbase client computes a 30-second trend signal (`'up'` / `'down'` / `'flat'`) based on price change percentage. This trend is passed to the strategy (or at minimum available to it) but is **only logged — never incorporated into entry or exit decisions**. 

A trend-confirming entry filter (e.g., only enter YES if trend is `'up'`, only enter NO if trend is `'down'`) would dramatically reduce false crosses from mean-reverting noise. Its absence means the bot enters against the trend as often as with it.

**Root cause:**  
The trend computation was built but the conditional check in `evaluate()` was never written.

**Exact fix:**  
Add trend confirmation as an entry filter:
```typescript
// In evaluate(), before calling placeEntryOrder:
if (crossUp && trend !== 'up') {
  return { action: 'none', reason: `Cross up detected but trend is '${trend}' — skipping to avoid noise` };
}
if (crossDown && trend !== 'down') {
  return { action: 'none', reason: `Cross down detected but trend is '${trend}' — skipping to avoid noise` };
}
```

---

### 🟡 MEDIUM — Issue #7: `pollIntervalMs` Default of 1ms Is Dangerously Low

**Severity:** MEDIUM  
**File:** `src/config.ts`

**Description:**  
`pollIntervalMs` defaults to **1 millisecond**. This means the strategy's evaluation loop will attempt to run ~1,000 times per second. At this rate:
- The Kalshi REST API will be hammered and will rate-limit or ban the key.
- The Coinbase WS price won't change between ticks (WS updates are not sub-millisecond), so consecutive evaluations will see identical prices and fire duplicate signals.
- Any async operations (balance fetch, order placement) not awaited properly will pile up.

**Root cause:**  
`pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 1)` — the unit is milliseconds, not seconds. This is either a unit confusion (intended as 1 second = 1000ms) or a typo.

**Exact fix:**  
```typescript
// Change default to 1000ms (1 second) or 500ms
pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 1_000),
```
Also add a minimum guard:
```typescript
if (config.strategy.pollIntervalMs < 100) {
  throw new Error('POLL_INTERVAL_MS must be >= 100ms to avoid API rate limits');
}
```

---

### 🟡 MEDIUM — Issue #8: `orderCooldownMs` Is Hardcoded to Zero — Not Configurable

**Severity:** MEDIUM  
**File:** `src/config.ts`

**Description:**  
`orderCooldownMs: 0` is hardcoded in the config object with no env override. Combined with the 1ms poll interval (Issue #7), this means there is **zero cooldown between consecutive order attempts**. A brief cross-and-recross of the strike will place two orders back-to-back with no guard. This is a flapping risk.

**Root cause:**  
```typescript
orderCooldownMs: 0, // hardcoded, not env-configurable
```

**Exact fix:**  
```typescript
orderCooldownMs: getEnvNumber('ORDER_COOLDOWN_MS', 5_000), // default 5s cooldown
```
And enforce it in the entry check:
```typescript
const msSinceLastOrder = Date.now() - this.lastOrderTimestamp;
if (msSinceLastOrder < config.strategy.orderCooldownMs) {
  return { action: 'none', reason: 'Order cooldown active' };
}
```

---

### 🟡 MEDIUM — Issue #9: `syntheticUnderlyingAlpha` of 0.05 Makes EMA Useless for Fast Signals

**Severity:** MEDIUM  
**File:** `src/config.ts`

**Description:**  
The EMA smoothing factor `syntheticUnderlyingAlpha = 0.05` means the EMA adapts at a rate of 5% per tick. This gives ~95% weight to the old value. With a poll rate of even 1 second, this EMA has a half-life of roughly **14 ticks / 14 seconds** — far too slow to track intraday BTC price moves for short-term arbitrage.

This means even if the EMA were wired into cross detection (per the fix in Issue #1), it would lag the true price badly and cause late entries.

**Root cause:**  
```typescript
syntheticUnderlyingAlpha: getEnvNumber('SYNTHETIC_UNDERLYING_ALPHA', 0.05),
```
Alpha of 0.05 is appropriate for long-term trend tracking, not sub-minute signal generation.

**Exact fix:**  
For a 1–5 second update frequency and an intended "near-real-time" price track, use alpha between 0.3–0.5:
```typescript
syntheticUnderlyingAlpha: getEnvNumber('SYNTHETIC_UNDERLYING_ALPHA', 0.33), // ~3-tick half-life
```
Or better: don't use an EMA for the underlying at all if you have direct API access to Kalshi's index. Only fall back to the EMA when the API fails.

---

### 🟢 LOW — Issue #10: `demoKalshiUnderlyingDollars` Inherits the Stale Reference Price

**Severity:** LOW  
**File:** `src/config.ts`

**Description:**  
`demoKalshiUnderlyingDollars` defaults to `demoKalshiUnderlyingDollars: getEnvNumber('DEMO_KALSHI_UNDERLYING_DOLLARS', getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 71052.06))` — which cascades the stale $71,052 default. In dry-run/paper mode, the simulated Kalshi underlying will start at a price that could be $20,000+ away from current BTC. This means paper trading results are meaningless and won't reflect live behavior.

**Root cause:**  
Nested fallback to the stale `referencePriceDollars`.

**Exact fix:**  
Once Issue #2 is fixed (forcing `KALSHI_REFERENCE_PRICE_DOLLARS` to be explicit), this inherits the correct value automatically. No additional fix needed beyond Issue #2.

---

### 🟢 LOW — Issue #11: `minSecondsBeforeExpiry` and `balanceFractionPerTrade` Are Hardcoded

**Severity:** LOW  
**File:** `src/config.ts`

**Description:**  
```typescript
minSecondsBeforeExpiry: 60,
balanceFractionPerTrade: 0.05,
```
These are hardcoded with no env override. Both are meaningful risk parameters that should be tunable without a code deploy.

**Exact fix:**  
```typescript
minSecondsBeforeExpiry: getEnvNumber('MIN_SECONDS_BEFORE_EXPIRY', 60),
balanceFractionPerTrade: getEnvNumber('BALANCE_FRACTION_PER_TRADE', 0.05),
```

---

## Root Cause Summary Table

| # | Issue | Severity | Entry Timing? |
|---|-------|----------|--------------|
| 1 | Cross detection uses fixed strike, not live index | 🔴 CRITICAL | ✅ Primary cause |
| 2 | Stale $71,052 fallback price | 🔴 CRITICAL | ✅ Compounds #1 |
| 3 | `kalshiEdgeThreshold` never enforced (zero-edge entries) | 🔴 CRITICAL | ⚠️ Risk/P&L only |
| 4 | Synthetic EMA computed but never used | 🟠 HIGH | ✅ Compounds #1 |
| 5 | `priceMoveThresholdPct` never enforced (noise entries) | 🟠 HIGH | ✅ Wrong-time entries |
| 6 | Trend signal computed but never used | 🟠 HIGH | ✅ Wrong-direction entries |
| 7 | `pollIntervalMs` defaults to 1ms (rate limit risk) | 🟡 MEDIUM | ⚠️ Operational |
| 8 | `orderCooldownMs` hardcoded to 0 (flapping) | 🟡 MEDIUM | ✅ Duplicate entries |
| 9 | EMA alpha 0.05 too slow for short-term arb | 🟡 MEDIUM | ✅ Late entries |
| 10 | `demoKalshiUnderlyingDollars` inherits stale price | 🟢 LOW | Paper mode only |
| 11 | `minSecondsBeforeExpiry` / `balanceFractionPerTrade` hardcoded | 🟢 LOW | Ops quality |

---

## Recommended Fix Order

1. **Fix Issue #1** — repoint cross detection to live Kalshi index (or `syntheticKalshiUnderlyingDollars`)
2. **Fix Issue #2** — remove/force `referencePriceDollars`; never use a stale hardcoded default
3. **Fix Issue #7** — change `pollIntervalMs` default to 1000ms before any live testing
4. **Fix Issue #4** — wire the existing EMA into the cross detection path (free win, code exists)
5. **Fix Issue #3** — enforce `kalshiEdgeThreshold` in `placeEntryOrder`
6. **Fix Issue #5 + #6** — add `priceMoveThresholdPct` and trend confirmation filters
7. **Fix Issue #8** — make `orderCooldownMs` env-configurable with a sane default (5s)
8. Remaining LOW issues at leisure

---

*Report generated by automated code review. All line references are based on the code excerpts provided.*
