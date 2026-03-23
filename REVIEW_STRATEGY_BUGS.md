# Strategy Bug Review — arbStrategy.ts

Reviewed by: subagent (senior quant engineer)  
File: `src/strategy/arbStrategy.ts`  
Date: 2026-03-21

---

## CRITICAL (breaks trading or causes losses)

### BUG-S1: TP/SL/near-expiry exits do not set `pendingPhase` → repeated IOC orders placed on every tick for ~500ms

**File**: `src/strategy/arbStrategy.ts:~632–663` (`checkProfitAndLossExits`)

**Problem**:  
When Take-Profit, Stop-Loss, near-expiry cut-loss, or thesis-failure exits fire, `placeMarketExitOrder` is called and the function returns. **`pendingPhase` and `pendingSide` are never set.** The position cache has a 500ms TTL (`POSITION_CACHE_TTL_MS = 500`). At ~100ms ticks that is ~5 ticks where the cache still shows a nonzero position.

On every one of those ticks:
- `checkProfitAndLossExits` sees `pendingPhase === null` (guard passes at line ~614)
- `bid - entry >= takeProfitCents` still true
- `canPlaceExitFlattenOrder` is called (no cooldown check — by design)
- `refreshOpenOrders` runs and sees the IOC already filled/cancelled → `openOrderIds` refreshed to empty
- A **new IOC market-exit order is placed**

Result: 4–5 redundant exit orders are placed against the same (already-closed) position. Since they're `reduce_only: true`, Kalshi should reject over-sells, but this hammers the API and can cause rate-limit 429s. Contrast with the `closeAtBreakeven` block (line ~318), which correctly sets `pendingPhase = 'exit'` after placing its exit.

**Fix**:  
After each `placeMarketExitOrder` call in `checkProfitAndLossExits` that returns a non-hold result, set pending state the same way `closeAtBreakeven` does:
```typescript
const exitRes = await this.placeMarketExitOrder(market, heldSide, count);
if (exitRes.action !== 'hold') {
  this.pendingSide = isLong ? 'short' : 'long';
  this.pendingPhase = 'exit';
  this.pendingSinceMs = Date.now();
}
return exitRes;
```
Apply to all four exit paths (TP, SL, near-expiry cut-loss, thesis-failure).

---

### BUG-S2: `isOrderbookUnavailable` falsely blocks trading in deep ITM/OTM (but still liquid) markets

**File**: `src/strategy/arbStrategy.ts:~213–218`

**Problem**:
```typescript
const yesUnavailable = market.yes_bid <= 0 && market.yes_ask <= 0;
const noUnavailable  = market.no_bid  <= 0 && market.no_ask  <= 0;
return yesUnavailable || noUnavailable;
```

For a deep ITM YES market (BTC $3 000 above strike with 5 min to expiry), NO contracts have effectively zero value. Kalshi will report `no_bid = 0, no_ask = 0` or `no_bid = 0, no_ask = 1`. The `noUnavailable` flag triggers, returning `true`, and **all trading is blocked — including perfectly valid YES-side trades.**

This is the exact scenario mentioned in checklist item 7 ("can both yes and no bids be 0 legitimately e.g. 99¢ strike far OTM"). The answer is yes, and the current guard doesn't handle it.

**Fix**:  
Block only the side you want to trade, not both sides unconditionally:
```typescript
private isOrderSideUnavailable(market: KalshiMarket, side: 'yes' | 'no'): boolean {
  if (side === 'yes') return market.yes_bid <= 0 && market.yes_ask <= 0;
  return market.no_bid <= 0 && market.no_ask <= 0;
}
```
Or gate only on the ask of the side being entered:
```typescript
// In placeEntryOrder, before computing askPriceCents:
if (side === 'yes' && market.yes_ask <= 0) return this.hold('YES ask unavailable');
if (side === 'no'  && market.no_ask  <= 0) return this.hold('NO ask unavailable');
```

---

## HIGH (likely to cause missed trades or incorrect behavior)

### BUG-S3: `computePositionSize` — division by zero when `askPriceCents = 0`

**File**: `src/strategy/arbStrategy.ts:~195–200`

**Problem**:
```typescript
const maxFromBalance = Math.floor(fractionBalance / askPriceCents);
return Math.max(1, Math.min(config.strategy.maxPositionSize, maxFromBalance));
```

If `askPriceCents = 0` (e.g., yes_ask is 0 while yes_bid > 0, which is an inconsistent but possible API state on a very thin book), `fractionBalance / 0 = Infinity`. `Math.min(maxPositionSize, Infinity) = maxPositionSize`. The order is then placed with `yes_price: 0`, which Kalshi will reject (price must be 1–99) — but there is no local guard preventing the attempt.

`isOrderbookUnavailable` only catches the case where **both** bid AND ask are ≤ 0 for a given side, so `yes_ask = 0 && yes_bid = 5` passes the current guard.

**Fix**:  
Add a zero-guard before division:
```typescript
if (askPriceCents <= 0) return 1; // degenerate; caller should have blocked this
const maxFromBalance = Math.floor(fractionBalance / askPriceCents);
```
And/or add a per-side ask check in `placeEntryOrder`:
```typescript
if (askPriceCents <= 0) return this.hold(`Ask price is 0 for side=${side} — skipping entry`);
```

---

### BUG-S4: Regime filter counts EMA crosses on every signal, including valid directional trades — `REGIME_MAX_CROSSES = 3` may pause legitimate trading

**File**: `src/strategy/arbStrategy.ts:~474–497`

**Problem**:  
`crossTimestamps` is incremented on **every** EMA cross signal — both entries and cross-based exits. Consider a legitimate trading sequence:
1. crossUp → entry (1 push)
2. crossDown → exit + pending re-entry (1 push)
3. crossUp → re-enter (1 push)
4. crossDown → exit + pending re-entry (1 push) ← triggers regime pause

Four signal-worthy crosses in a trending-then-reversing market within 5 minutes = regime pause. The original intent (per the "too many STRIKE crossings" comment) was to detect BTC whipsawing back and forth across the dollar strike price. EMA crosses are much more frequent than strike crossings. The threshold and window may not have been recalibrated when the regime filter was migrated from strike-cross to EMA-cross counting.

**Fix**:  
Either (a) raise `REGIME_MAX_CROSSES` to a more appropriate value for EMA-frequency crosses (e.g., 6–8), (b) count only specific cross types (e.g., direction reversals), or (c) restore a distinct strike-crossing regime filter alongside the EMA signal.

---

### BUG-S5: Pending re-entry after reversal exit bypasses the spread gate

**File**: `src/strategy/arbStrategy.ts:~388–405` (pendingPhase === 'exit' resolved block)

**Problem**:  
When a cross-based reversal exit completes (`positionContracts === 0` in pending exit phase), `placeEntryOrder` is called immediately:
```typescript
const entryRes =
  this.pendingSide === 'long'
    ? await this.placeEntryOrder(market, 'yes')
    : await this.placeEntryOrder(market, 'no');
```

The spread gate in the flat-entry path (lines ~522–534):
```typescript
const yesSpread = market.yes_ask - market.yes_bid;
if (yesSpread > 8) {
  return this.hold(`Spread too wide for YES entry: ${yesSpread}¢ > 8¢`);
}
```
is **not applied** in the pending-exit-resolved path. If the book widens during the exit wait, the bot will enter into a wide-spread market it would have rejected from a fresh flat state.

**Fix**:  
Check spread before the `placeEntryOrder` call in the pending-exit resolution block, mirroring the flat-entry logic.

---

## MEDIUM (edge cases, logic errors)

### BUG-S6: `prevKalshiUnderlyingPriceDollars` is tracked but never read — dead state

**File**: `src/strategy/arbStrategy.ts:~35` (declaration), `~308` (write), `~273` (reset)

**Problem**:  
`this.prevKalshiUnderlyingPriceDollars` is assigned on every tick and reset on ticker rotation, but is **never read** for any decision. It appears to be a remnant of an older cross-detection scheme that compared Kalshi underlying vs strike (the original "prevKalshiUnderlyingPriceDollars" was used alongside `prevCoinbasePrice` for the now-removed strike-crossing signal). It occupies state that's updated on every tick with no purpose.

**Fix**:  
Remove the field and all assignments, or repurpose it if future diagnostic use is intended (but document it clearly).

---

### BUG-S7: Realized P/L is only computed for cross-based exits, not TP/SL exits

**File**: `src/strategy/arbStrategy.ts:~380–390` (pendingPhase exit resolved)

**Problem**:  
Realized P/L is computed when `pendingPhase === 'exit'` resolves to `positionContracts === 0`, using `armedTpExitLimitCents`:
```typescript
const realized = this.currentTradeCount * (this.armedTpExitLimitCents - this.currentTradeEntryLimitCents);
```
But `armedTpExitLimitCents` is **only set in the cross-based exit path** (long→down-cross, short→up-cross). TP/SL exits (via `checkProfitAndLossExits`) never set `armedTpExitLimitCents` and never set `pendingPhase`, so the realized P/L block is never reached for TP/SL trades. Dashboard always shows 0 or stale realized P/L after a TP/SL hit.

This is a dashboard-only issue (no trading logic affected), but misleading for live monitoring.

**Fix**:  
When TP/SL fires, compute and store realized P/L immediately before the exit:
```typescript
// In checkProfitAndLossExits, before each placeMarketExitOrder:
if (this.currentTradeEntryLimitCents !== null && this.currentTradeCount !== null) {
  const realized = this.currentTradeCount * (bid - this.currentTradeEntryLimitCents);
  this.currentTradePnLCents = Math.round(realized);
  this.currentTradePnLMode = 'realized';
}
```

---

### BUG-S8: `now` is shadowed inside the `else` block for position cache refresh

**File**: `src/strategy/arbStrategy.ts:~298–308`

**Problem**:
```typescript
const now = Date.now();                   // outer 'now' — used for regime filter, cross pruning
if (now < this.regimePausedUntilMs) { ... }
this.crossTimestamps = this.crossTimestamps.filter(t => now - t < ...);
// ...
} else {
  const now = Date.now();                 // inner 'now' — shadows outer, used for position cache TTL
  if (now - this.lastPositionFetchMs >= ArbStrategy.POSITION_CACHE_TTL_MS) { ... }
}
```

The inner `const now` shadows the outer one. The regime prune and the position TTL check use two different `Date.now()` calls, milliseconds apart. Not a functional bug in practice, but if the outer `now` is used after the else block (it isn't currently), this would silently use the stale value. Also makes the code harder to reason about.

**Fix**:  
Remove the inner `const now = Date.now()` and reuse the outer `now`. Or hoist a single `const nowMs = Date.now()` at the top of the function.

---

## LOW (minor / cosmetic issues)

### BUG-S9: Regime filter log message says "too many strike crosses" but counts EMA crosses

**File**: `src/strategy/arbStrategy.ts:~484, ~495`

**Problem**:
```typescript
logger.warn('Regime filter triggered — too many strike crosses, pausing 2 min', { ... });
```
The crosses being counted are **EMA5/EMA20 crosses**, not BTC-vs-strike crossings. This is a stale message from when the regime filter tracked the old `crossUp`/`crossDown` based on `prevCoinbasePrice vs kalshiUnderlyingPrice`. The log will mislead anyone monitoring the live feed or parsing logs for signals.

**Fix**:  
Update to: `'Regime filter triggered — too many EMA crosses, pausing 2 min'`

---

### BUG-S10: `isEvaluating` concurrency guard is not present in this file

**File**: N/A (arbStrategy.ts has no such guard)

**Problem**:  
`evaluate()` is `async` and contains multiple sequential `await` calls (position fetch, order placement, open-order refresh). If the polling loop does not guard with a mutex/`isEvaluating` flag, two concurrent Coinbase ticks could enter `evaluate()` simultaneously, causing state machine corruption: e.g., both ticks see `isFlat`, both pass the cross check, and two entry orders are placed simultaneously.

This guard appears to be the caller's responsibility. If it exists in the polling loop, this is a non-issue. If not, it is a CRITICAL gap.

**Recommendation**:  
Confirm `isEvaluating` (or equivalent) is set to `true` before calling `evaluate()` and cleared in a `finally` block in the polling caller. If it is missing, add it there.

---

## NOTES (observations, not bugs)

**EMA alpha values are reasonable for the stated strategy**:  
`EMA5_ALPHA = 2/(5+1) ≈ 0.333`, `EMA20_ALPHA = 2/(20+1) ≈ 0.095`. At ~100ms ticks, the fast EMA tracks ~500ms of price history; the slow EMA tracks ~2s. This is well-matched to the stated "Coinbase leads Kalshi by 1–5 seconds" hypothesis. Alphas are correct.

**Cross detection logic is sound on the happy path**:  
`prevEma5s < prevEma20s && ema5s >= ema20s` is a standard one-bar crossover. The initialization (both EMAs = coinbasePrice on first tick) means `prevEma5s = prevEma20s` on tick 2, so the strict `<` condition prevents a false cross when EMAs first diverge from equal start. Null guards are correctly handled by the `prevEma5s === null` early-return check.

**Edge check direction for `placeEntryOrder` is correct**:  
`edge = fairValueCents - askPriceCents`. Positive edge means fair value exceeds ask → market is cheap relative to our model → enter. Correct for both YES and NO sides.

**`coinbaseToNoLimitCents` uses complement of YES correctly**:  
Binary contract constraint: YES + NO = 100¢ at expiry. Using `100 - fairValueYesCents` as NO fair value is correct.

**`reduce_only: true` with `type: 'ioc'` on all exits is correct Kalshi API usage**:  
This prevents exits from accidentally opening new positions and waives margin requirements. Design is sound.

**Position cache TTL (500ms) vs tick rate (~100ms)**:  
The cache avoids blocking every tick on a slow API call. However, it creates a window where post-TP/SL the position appears nonzero for ~5 more ticks — directly causing BUG-S1. Consider force-invalidating the cache (set `lastPositionFetchMs = 0`) immediately after placing any exit order so the next tick fetches fresh position data.
