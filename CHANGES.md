# CHANGES.md — Strategy Fix (2026-03-21)

## Summary

Major strategy overhaul based on code review findings. The bot was entering on every strike-cross regardless of signal quality — this fix adds 5 entry gates and replaces the broken exit logic.

---

## config.ts

| Parameter | Before | After |
|-----------|--------|-------|
| `referencePriceDollars` default | $71,052 (stale 2024 price) | $85,000 |
| `demoKalshiUnderlyingDollars` default | $71,052 | $85,000 |
| `orderCooldownMs` | `0` (hardcoded, no cooldown) | `45,000ms` (env: `ORDER_COOLDOWN_MS`) |
| `minSecondsBeforeExpiry` | `60s` | `180s` (3 min, env: `MIN_SECONDS_BEFORE_EXPIRY`) |
| `pollIntervalMs` default | `1ms` (would rate-limit API) | `1000ms` (env: `POLL_INTERVAL_MS`) |
| `kalshiEdgeThreshold` default | `3` cents | `7` cents (env: `KALSHI_EDGE_THRESHOLD`) |

### New config fields
- `maxSecondsBeforeExpiry` (default: 720s / 12 min) — don't trade with too much time left
- `displacementThresholdPct` (default: 0.15%) — BTC must be this far past strike before entry
- `takeProfitCents` (default: 10¢) — exit when position gains this much
- `stopLossCents` (default: 12¢) — exit when position loses this much

---

## src/strategy/arbStrategy.ts

### Entry Fixes

1. **TTE window gate** — Added `maxSecondsBeforeExpiry` upper bound. Now only trades 3–12 min before expiry (sweet spot: lag is exploitable but uncertainty is manageable).

2. **Displacement gate** — Added before both crossUp and crossDown entries. BTC must be ≥0.15% past the strike to enter. Filters noise crosses where BTC touches the strike by $10 and immediately reverses.

3. **Edge check in `placeEntryOrder`** — Now computes `fairValue - ask` before every entry. If Kalshi has already repriced (edge < requiredEdge), the trade is skipped. Required edge = `max(kalshiEdgeThreshold, spread + 3¢)` — dynamically adjusts for wide spreads.

### Exit Fixes

4. **`checkProfitAndLossExits` method (new)** — Runs before cross detection on every tick:
   - **Take Profit**: Exit when `bid - entry ≥ +10¢` (lag-exploitation complete, don't hold)
   - **Stop Loss**: Exit when `bid - entry ≤ -12¢` (thesis was wrong, cut it)
   - **Near-expiry hold**: If <3 min left and winning (BTC on our side), hold to expiry — theta works for us
   - **Near-expiry cut**: If <3 min left and losing, exit immediately — don't let it go to $0
   - **Thesis failure**: If <5 min left and still down >5¢, exit — stop hoping for a reversal

5. **`lastEvaluatedCoinbasePrice` field (new)** — Stores the current Coinbase price for use inside `placeEntryOrder` (needed for edge calculation without threading it through every call).

---

## What Was NOT Changed
- `src/kalshi/client.ts` — untouched
- `.env` — untouched
- Core cross-detection logic — still uses Coinbase vs. strike sign change, but now gated by displacement + edge + TTE

---

## Expected Behavior After Fix

- Bot will be **silent more often** (that's correct — quality over quantity)
- When it does enter, it should have ≥7¢ of edge on average
- Exits happen at TP (+10¢), SL (-12¢), or near-expiry logic — not on the next random cross
- No more churn in choppy markets (45s cooldown + displacement gate)
