# KalshiARB2 — Strategy Design Review

**Analyst:** Chief (Subagent)  
**Date:** 2026-03-21  
**Scope:** Strategy design evaluation only. Not a code audit.

---

## TL;DR

The current entry signal is broken by design. Strike-cross is a valid *idea* but a naive implementation — it ignores price momentum, time-to-expiry, Kalshi lag magnitude, and spread cost. The dead config parameters (`priceMoveThresholdPct`, `kalshiEdgeThreshold`) hint that the *correct* strategy was partially designed but never wired up. The fix is not a rewrite — it's activating and tuning what's already partially planned.

---

## 1. Is the Strike-Cross Entry Signal Valid?

### The Thesis

The underlying idea is sound: Kalshi is a slower market. When Coinbase moves BTC decisively through the strike price, Kalshi YES/NO prices haven't fully repriced yet. You're exploiting the repricing lag — buying the binary at a "stale" price before the market catches up.

This is a legitimate microstructure arbitrage. Similar in concept to stat-arb across correlated instruments.

### When It Works

| Condition | Why It Works |
|-----------|-------------|
| Sharp, decisive cross (>0.1% in 1–2s) | Kalshi lags behind a fast move — you get the old price |
| Cross happens with >5 min to expiry | Enough theta-time for the market to reprice toward your direction |
| Wide Kalshi spread at time of cross | Market is thin → lag is larger → more edge |
| BTC in a trending regime (not choppy) | Cross is more likely to be a real directional signal |

### When It Fails

| Condition | Why It Fails |
|-----------|-------------|
| **Whipsaw / noise cross** | BTC touches strike by $10, immediately reverses. You entered on noise. Cost: the bid-ask spread. With 0 cooldown, this can happen dozens of times. |
| **Cross near expiry (<5 min)** | Kalshi has already priced this in. No lag to exploit. You're paying spread for zero edge. |
| **Cross when BTC is range-bound around strike** | You'll be entering and exiting repeatedly on both sides, paying spread every time. Death by a thousand cuts. |
| **Large gap-down/up cross** | If BTC jumped $500 through the strike, Kalshi has already moved. The lag window is gone before your order hits. |
| **Low Kalshi liquidity** | Slippage on entry makes the trade negative EV before it starts. |

### Verdict

The signal is *necessary but not sufficient*. A cross is a precondition, not an entry trigger by itself. The current bot fires on every cross regardless of quality. That's the root problem.

---

## 2. Better Entry Signal: Lag-Exploitation with Quality Filters

The correct signal is: **"Coinbase has moved decisively, Kalshi hasn't repriced yet, and we have enough time left."**

Decompose this into three gates, all of which must pass:

### Gate 1 — Price Displacement (Use `priceMoveThresholdPct`)

Don't enter on a tick cross. Enter when BTC has moved meaningfully through the strike.

```
Required: |coinbase_price - strike| / strike > priceMoveThresholdPct
```

**Recommended threshold:** `0.10%` to `0.20%` (not 0.05% — too noisy).

- At $85,000 BTC, 0.10% = $85 past the strike before entering.
- This filters out the $5–$20 noise crosses that immediately reverse.
- Tune based on backtested whipsaw rate.

### Gate 2 — Kalshi Lag Confirmation (Use `kalshiEdgeThreshold`)

Check whether Kalshi has *already* repriced. If it has, the arbitrage is gone.

```
For YES entry (BTC above strike):
  fair_value = f(distance_from_strike, time_to_expiry)  # see Gate 3
  edge = fair_value - kalshi_ask_price
  Required: edge > kalshiEdgeThreshold (e.g., 5¢)
```

This is the single most important filter. If Kalshi YES is already at 85¢ and fair value is 87¢, you have 2¢ of edge against a 3¢ spread. That's a losing trade. **Don't take it.**

**Recommended threshold:** `5–8 cents` minimum edge (not 3¢ — need to cover spread plus buffer).

### Gate 3 — Time-to-Expiry Window

Only trade in a specific TTE window where:
- Enough time remains for Kalshi to reprice (the "catch-up" window)
- But not so much time that uncertainty overwhelms the signal

```
Required: 3 min < time_to_expiry < 12 min
```

Rationale:
- **< 3 min**: Kalshi has usually already priced in the displacement. No lag left.
- **> 12 min**: Too much randomness. BTC can wander $500 in 12 minutes. The cross is less predictive.
- **Sweet spot: 4–9 min**: Displacement is clear, Kalshi is lagging, but resolution is near enough that YES approaches certainty faster.

### Gate 4 — Momentum Confirmation (New)

Confirm the cross is directional, not noise.

```
Required: EMA(5s) > EMA(20s)  [for YES entry]
OR: price_velocity = (price_now - price_5s_ago) / price_5s_ago > 0.05%
```

A 5s/20s exponential moving average crossover on Coinbase tick data is cheap to compute and filters whipsaws well.

### Combined Entry Logic

```
ENTER YES if:
  1. coinbase_price > strike  (basic condition)
  2. (coinbase_price - strike) / strike > 0.15%  (Gate 1: displacement)
  3. kalshi_fair_value(tte, distance) - kalshi_ask > 7¢  (Gate 2: lag confirmed)
  4. 3min < tte < 12min  (Gate 3: TTE window)
  5. ema_5s > ema_20s  (Gate 4: momentum)
  6. time_since_last_order > 30s  (Gate 5: cooldown — fix the 0ms cooldown)
```

Mirror logic for NO entry.

---

## 3. Should `kalshiEdgeThreshold` Be Used? How?

**Yes. Absolutely. This is the most critical dead feature.**

Without it, the bot is not an arbitrage bot — it's a directional momentum bot paying full spread. The edge check is what separates arbitrage from gambling.

### How to Implement It

You need a fair value model for the binary. The simplest usable model:

**Empirical approach (best for this use case):**

Build a lookup table from historical data:
```
fair_value = f(|coinbase - strike| / strike, time_to_expiry_seconds)
```

Example calibrated values (approximate, needs backtesting):

| Distance from Strike | TTE 10min | TTE 5min | TTE 2min |
|---------------------|-----------|----------|----------|
| 0.05% above strike  | 58¢       | 62¢      | 68¢      |
| 0.10% above strike  | 63¢       | 70¢      | 80¢      |
| 0.20% above strike  | 70¢       | 80¢      | 91¢      |
| 0.50% above strike  | 82¢       | 92¢      | 98¢      |

**Analytic approach (faster to implement, less accurate):**

Approximate with a log-normal binary option formula:
```
d = (ln(coinbase/strike) + 0.5 * σ² * T) / (σ * √T)
fair_value = N(d)  # where N = CDF of standard normal, σ = BTC 15min vol
```

BTC 15-min annualized vol ≈ 70–90%. Adjust σ based on recent realized vol.

**Entry rule:**
```
DO NOT ENTER if (fair_value - ask_price) < kalshiEdgeThreshold
Recommended threshold: 7¢ (not 3¢)
```

3¢ doesn't cover the typical 3–5¢ bid-ask spread plus any slippage. You need at minimum spread + 2–3¢ buffer = ~6–8¢ minimum edge to have positive EV.

---

## 4. Better Exit Strategy

### Current Exit: "Exit on next cross"

This is deeply flawed:
- In a trending market, you hold until expiry (which is fine) OR until a reversal (which wipes gains)
- In a choppy market, you exit early on every micro-reversal, paying spread twice per round-trip
- No consideration of whether you're holding a winner near expiry

### Proposed Exit Framework: **Profit Target + Time-Based**

#### Exit Tier 1 — Take Profit at Kalshi Repricing

```
EXIT YES if: kalshi_bid_price > entry_ask_price + 10¢
```

If you bought YES at 52¢ and Kalshi has repriced to 62¢+, take the money. The lag-exploitation is complete. Don't hold for more.

This should capture 80% of the trades. The remaining 20% go to tier 2.

#### Exit Tier 2 — Time-to-Expiry Based Hold/Exit

```
If TTE > 5min AND position is losing (kalshi_bid < entry_ask - 5¢):
  EXIT: momentum signal failed, cut losses

If TTE < 3min AND YES is winning (BTC above strike):
  HOLD until expiry: theta is working for you, don't pay spread to exit
  
If TTE < 3min AND YES is losing (BTC below strike):
  EXIT immediately: cut the $X loss, don't risk going to $0
```

#### Exit Tier 3 — Stop Loss

```
EXIT if kalshi_bid < entry_ask - 12¢ at any time
```

Hard stop. If you're 12¢ underwater, the thesis is wrong. Get out.

#### Summary Exit Decision Tree

```
At each tick:
  1. kalshi_bid > entry + 10¢ → TAKE PROFIT
  2. kalshi_bid < entry - 12¢ → STOP LOSS
  3. tte < 3min AND btc above strike (YES trade) → HOLD TO EXPIRY
  4. tte < 3min AND btc below strike (YES trade) → EXIT NOW
  5. tte < 5min AND kalshi_bid < entry - 5¢ → EXIT, thesis failed
  6. Otherwise → HOLD
```

---

## 5. Additional Strategy Improvements

### 5.1 Fix the Cooldown (Critical)

`orderCooldownMs: 0` is dangerous. In a choppy market around the strike, the bot can fire 10–20 orders per minute, each paying full spread.

**Set cooldown to 30–60 seconds minimum.** After an exit, don't re-enter the same direction within 60s unless the signal is much stronger (e.g., > 0.3% displacement).

### 5.2 Per-Strike Position Tracking

The bot should track which strikes it's currently positioned in. Kalshi runs multiple concurrent KXBTC15M markets (each 15-min window has its own market). Avoid building up multiple positions in the same direction across overlapping windows without accounting for correlated risk.

### 5.3 Volatility-Adjusted Position Sizing

`balanceFractionPerTrade: 5%` is flat. It should scale inversely with edge uncertainty:

```
position_size = base_size * (edge / 10¢) * (1 / btc_15min_vol_multiplier)
```

When edge is thin (7¢), size down. When edge is fat (20¢+), size up — but cap at `maxPositionSize`.

### 5.4 Market Microstructure: ASK Entry is Correct, But Watch Spread

Entering at ASK (taking liquidity) is correct for lag-exploitation — you need to get filled immediately before Kalshi reprices. But **check the spread before entering**:

```
DO NOT ENTER if (ask - bid) > 8¢
```

A wide spread means the market is illiquid. You'll pay more on entry and get worse fill on exit. The edge threshold should account for the current spread dynamically:

```
Required edge = max(kalshiEdgeThreshold, (ask - bid) + 3¢)
```

### 5.5 Time-of-Day Filter

BTC binary markets are most liquid and most efficiently priced during US market hours (9:30am–4pm ET) and less liquid overnight. The lag-exploitation opportunity is actually *larger* in low-liquidity hours — but so is slippage risk.

Consider separate parameter sets for:
- **High liquidity (9am–5pm ET)**: Tighter thresholds, faster repricing, smaller edge
- **Low liquidity (overnight)**: Wider spread tolerance, larger required edge (12¢+)

### 5.6 Regime Filter

The strategy only works when BTC is making directional moves. In a flat/choppy regime (BTC oscillating ±0.05% around the strike), the bot will churn endlessly.

Add a simple regime filter:
```
If 5-minute realized vol < 0.05% annualized equivalent → PAUSE TRADING
```

Or equivalently: if BTC has crossed the strike more than 3 times in the last 5 minutes, pause for 2 minutes.

### 5.7 Log Every Trade with Full State

This is operational but critical for strategy improvement:

Log at time of entry: `[tte, displacement_pct, kalshi_edge, spread, ema_diff, btc_vol_5min]`

Without this, you cannot backtest or tune. The bot is flying blind on whether the entry conditions are predictive.

---

## Prioritized Action Plan

| Priority | Change | Expected Impact |
|----------|--------|-----------------|
| 🔴 P0 | Wire up `kalshiEdgeThreshold` as a real gate (min 7¢) | Eliminates zero-edge trades |
| 🔴 P0 | Set `orderCooldownMs` to 30,000–60,000 | Prevents churn in choppy conditions |
| 🔴 P0 | Add displacement gate: require `>0.15%` past strike | Filters noise crosses |
| 🟡 P1 | Add TTE window: only trade 3–12 min before expiry | Focuses on highest-edge window |
| 🟡 P1 | Replace "exit on cross" with profit target + stop loss | Better risk/reward per trade |
| 🟡 P1 | Add TTE-based exit logic (hold vs. cut near expiry) | Reduces unnecessary spread payments |
| 🟢 P2 | Add momentum filter (EMA 5s/20s) | Reduces whipsaw entries |
| 🟢 P2 | Dynamic position sizing based on edge magnitude | Better EV per dollar risked |
| 🟢 P2 | Regime filter: pause in flat/choppy BTC | Avoids negative EV environment |
| 🟢 P3 | Build fair value model (empirical table or log-normal) | Enables accurate edge calculation |
| 🟢 P3 | Time-of-day parameter sets | Handles liquidity variation |

---

## One-Sentence Bottom Line

The bot has the right idea but wrong execution: it enters on a *necessary* condition (strike cross) rather than a *sufficient* one (strike cross + displacement + Kalshi lag confirmed + favorable TTE + momentum) — fixing that alone will transform it from a spread-burning machine into an actual arbitrage system.
