# Config/Integration Bug Review — config / coinbase / index / dashboard

> Reviewed files: `src/config.ts`, `src/coinbase/client.ts`, `src/index.ts`, `src/dashboardServer.ts`
> Focus: bugs only — no style, no refactoring.

---

## CRITICAL

### BUG-C1: `new KalshiClient()` created on every `/api/demo-market-seed` request — resource leak
**File**: `src/dashboardServer.ts` (around `app.get('/api/demo-market-seed', ...)`)  
**Problem**: The endpoint creates `const client = new KalshiClient()` on every call. The dashboard frontend polls `/api/demo-market-seed` via `seedDemoInputsFromLiveMarket()` on page load, plus the refresh loop calls `/api/state` and `/api/trades` every 2 seconds. Any scenario where the seed endpoint is repeatedly called (page reloads, integration tests) will accumulate KalshiClient instances that are never cleaned up. If `KalshiClient` holds HTTP keep-alive agents, timers, or open connections in its constructor/initial calls, this leaks file descriptors and memory over time.  
**Fix**: Instantiate one shared `KalshiClient` at module scope (or reuse the one owned by `BotRunner`/`runner`) and pass it to the endpoint handler. Never construct per-request.

---

## HIGH

### BUG-H1: Nested `getEnvNumber` in `demoKalshiUnderlyingDollars` throws even when outer env is set
**File**: `src/config.ts:105–109`  
**Problem**:
```ts
demoKalshiUnderlyingDollars: getEnvNumber(
  'DEMO_KALSHI_UNDERLYING_DOLLARS',
  getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 85000)  // ← always evaluated
),
```
JavaScript evaluates all function arguments eagerly. The inner `getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 85000)` is *always* evaluated — even when `DEMO_KALSHI_UNDERLYING_DOLLARS` is explicitly set. If a user sets `KALSHI_REFERENCE_PRICE_DOLLARS=abc` by mistake (or accidentally leaves a stale value), `getEnvNumber` throws `"Environment variable KALSHI_REFERENCE_PRICE_DOLLARS must be a number"` — **even though `DEMO_KALSHI_UNDERLYING_DOLLARS` is valid and present**. The bot crashes at startup with a confusing error.  
**Fix**:
```ts
demoKalshiUnderlyingDollars: getEnvNumber(
  'DEMO_KALSHI_UNDERLYING_DOLLARS',
  getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 85000)
),
```
Refactor to a lazy evaluation:
```ts
const refPrice = getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 85000);
// ...then in strategy block:
demoKalshiUnderlyingDollars: getEnvNumber('DEMO_KALSHI_UNDERLYING_DOLLARS', refPrice),
referencePriceDollars: refPrice,
```
This also avoids parsing `KALSHI_REFERENCE_PRICE_DOLLARS` twice.

### BUG-H2: `theoreticalBalanceDollars` / `demoUnderlyingDollars` / `demoTargetDollars` not validated for NaN in `/api/start`
**File**: `src/dashboardServer.ts` (around `app.post('/api/start', ...)`)  
**Problem**:
```ts
const theoreticalBalanceDollars = Number(req.body?.theoreticalBalanceDollars ?? 1000);
const demoUnderlyingDollars = req.body?.demoUnderlyingDollars !== undefined
  ? Number(req.body.demoUnderlyingDollars) : undefined;
```
`Number("")`, `Number(null)`, `Number("abc")` all produce `NaN`. There is **no isNaN guard** before passing these to `runner.start(...)`. If the frontend sends a malformed body (race between page load and a faulty network), the runner will be started with `NaN` balances and/or `NaN` underlying price. Strategy arithmetic on NaN propagates silently: every comparison involving NaN is false, so cross-detection may never fire, or a divide-by-zero equivalent (NaN contracts) could reach the order API.  
**Fix**: Add explicit validation before use:
```ts
if (!Number.isFinite(theoreticalBalanceDollars) || theoreticalBalanceDollars <= 0) {
  res.status(400).json({ error: 'theoreticalBalanceDollars must be a positive number' });
  return;
}
```
Apply the same guard to `demoUnderlyingDollars` and `demoTargetDollars`.

### BUG-H3: Dashboard has no authentication — full bot control exposed on local network
**File**: `src/dashboardServer.ts` (Express app, all routes)  
**Problem**: The Express server has no authentication middleware, no API key, no token check. It listens on `0.0.0.0:DASHBOARD_PORT` (default 3000) with CORS fully open (no `cors()` middleware restricting origins). Anyone on the local network — or any browser tab that can reach that port via `localhost` — can `POST /api/start`, `POST /api/stop`, `POST /api/breakeven-toggle`, effectively starting a **live** trade session or halting a running one. In a shared network or VPS deployment this is exploitable.  
**Fix**: At minimum add a pre-shared token check on mutating routes:
```ts
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-dashboard-token'] !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
```
Or bind the server to `127.0.0.1` only.

### BUG-H4: `balanceFractionPerTrade` is hardcoded — cannot be overridden without code change
**File**: `src/config.ts:120`  
**Problem**:
```ts
balanceFractionPerTrade: 0.05,
```
This field is in the `Config` interface and used by the strategy to size orders, but there is **no env variable fallback** — it's a literal. Every other strategy knob is env-configurable. A user who wants to trade 2% or 10% of balance must edit source code and rebuild. More critically, there is **no `Config` comment or `.env.example` entry** for this parameter, making it invisible.  
**Fix**:
```ts
balanceFractionPerTrade: getEnvNumber('BALANCE_FRACTION_PER_TRADE', 0.05),
```
Add to `.env.example` with a warning that values above 0.10 meaningfully increase drawdown risk.

---

## MEDIUM

### BUG-M1: No heartbeat/ping subscription to Coinbase Advanced Trade WS — silent drops
**File**: `src/coinbase/client.ts` (subscribe method)  
**Problem**: The Coinbase Advanced Trade WebSocket server will close idle connections after approximately 60 seconds of no messages. The bot subscribes to `ticker` only. In low-volatility periods (no BTC price movement for > 60s), the server silently closes the socket. The `'close'` event will fire and reconnect will trigger, but in the window between the silent drop and reconnect, the bot is running with stale price data without knowing it. Worse: after reconnect, the first tick could trigger a trade that should have been gated on a trend that now has a gap in its window.  
**Fix**: Subscribe to the `heartbeats` channel simultaneously:
```ts
const subscribeMsg = {
  type: 'subscribe',
  product_ids: [config.coinbase.productId],
  channel: 'heartbeats',
};
this.ws.send(JSON.stringify(subscribeMsg));
```
Or send a WebSocket-level ping every 30s:
```ts
this.pingTimer = setInterval(() => {
  if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
}, 30_000);
```
Clear `pingTimer` in `disconnect()`.

### BUG-M2: `trend` is always `flat` for the first `trendWindowSeconds` (30s) and after every reconnect
**File**: `src/coinbase/client.ts:computePriceData()`  
**Problem**: On startup (and after reconnect, since `priceHistory` survives reconnect but `latestPrice` is retained from before the gap), `windowHistory` contains only 1 point. With a single point, `oldestInWindow.price === currentPrice`, so `priceChangePct = 0` and `trend = 'flat'`. The bot will not enter a trade during the first 30 seconds of operation or after a reconnect — even if BTC is moving strongly. This is a silent suppression that the operator cannot observe without debug logging.  
**Fix**: At minimum, log a warning when entering with fewer than N points in the window so the operator knows the trend is unreliable. Optionally, seed the history from `getLatestData()` before the first tick or reduce the minimum required window to (e.g.) 5 ticks.

### BUG-M3: Timers started before Coinbase and Kalshi connections are established
**File**: `src/index.ts:~line 200–210`  
**Problem**: The execution order in `main()` is:
1. `void logBalance()` — immediately calls `strategy.getDemoCashCents()` or `kalshiClient.getBalance()`
2. `balanceLogTimer = setInterval(...)` — fires every 60s
3. `statusTimer = setInterval(...)` — fires every 2s
4. `await kalshiClient.getMarkets(...)` — auto-discovery (can take 1-3s)
5. `coinbaseClient.connect()` and `void runKalshiFetchLoop()`

Steps 1-3 run before the Kalshi fetch loop or Coinbase WS are active. The 2-second `logStatus()` timer will fire multiple times with all cached values at 0 before any real data arrives. More critically, `logBalance()` fires immediately in live mode and calls `kalshiClient.getBalance()` — a live REST call — before the bot is even wired up. If this throws (auth error, network hiccup), the error is swallowed in the timer callback. The `cachedStartBalanceCents` will be 0 and never corrected (because the guard `if (cachedStartBalanceCents === 0) cachedStartBalanceCents = balanceCents` only sets it once).  
**Fix**: Move `void logBalance()` and both `setInterval` calls to **after** `coinbaseClient.connect()` and `void runKalshiFetchLoop()`. Or at minimum, only start the balance timer after the first successful balance fetch.

### BUG-M4: `priceHistory` not cleared on reconnect — stale window after long disconnect
**File**: `src/coinbase/client.ts` (reconnect flow)  
**Problem**: `priceHistory` accumulates indefinitely and is only pruned in `processTicker()` when a new price arrives. After a long Coinbase disconnect (> `trendWindowSeconds` = 30s), the history may contain **zero** points (all pruned on next tick) OR the history window shows a stale price from pre-disconnect as `oldestInWindow`. When the first post-reconnect tick arrives, `priceChangePct` is computed as `(newPrice - stalePreDisconnectPrice) / stalePreDisconnectPrice * 100`. If BTC moved significantly during the outage (gap up/down), this will appear as a sharp trend cross and could trigger an immediate order.  
**Fix**: Clear `priceHistory` in `connect()` before establishing the new socket:
```ts
connect(): void {
  this.priceHistory = [];  // reset on reconnect — stale window is unsafe
  // ...existing code
}
```

---

## LOW

### BUG-L1: `referencePriceDollars` default is $85,000 but can diverge from live BTC without alerting the operator
**File**: `src/config.ts:103`  
**Problem**: The default `referencePriceDollars: 85000` is reasonable today, but this value is the fixed strike reference for cross-detection. If BTC moves to $90k or $80k and the operator doesn't update `KALSHI_REFERENCE_PRICE_DOLLARS`, the displacement calculation (`|coinbasePrice - referencePriceDollars|`) will always be large, triggering trades spuriously. There is no startup validation that checks whether `referencePriceDollars` is within a reasonable range of live BTC.  
**Fix**: At startup, log a warning if `abs(latestCoinbasePrice - referencePriceDollars) / referencePriceDollars > 0.05` (more than 5% off). This can be done in `evaluateOnTick` after the first valid price arrives.

### BUG-L2: `isEvaluating` guard silently drops every price tick during evaluation
**File**: `src/index.ts:~evaluateOnTick()`  
**Problem**:
```ts
if (isEvaluating) return;
```
Any Coinbase tick that arrives while the previous evaluation is still in progress (Kalshi REST round-trip) is **completely discarded** — not queued. The bot only re-evaluates on the *next* tick after the current evaluation completes. In fast markets, BTC can cross and retrace within a single evaluation window, meaning the cross tick is missed entirely. This is a design tradeoff, but it is a bug in the context of a *latency* arbitrage bot where each tick matters.  
**Fix**: Use a "dirty flag" instead: set `pendingTick = coinbaseData` inside the guard, and after `isEvaluating = false`, check `pendingTick` and evaluate it immediately. This ensures the most-recent price is always processed even if intermediate ticks were coalesced.

### BUG-L3: `maxPositionSize` default of 50 contracts is undocumented relative to dollar risk
**File**: `src/config.ts:106`  
**Problem**: `maxPositionSize: 50` is the maximum contracts per trade. In Kalshi BTC markets, each contract pays $1 if it resolves YES (0 if NO). At 50 contracts bought at 50¢ each, the cost is $25, and max payout is $50. This looks benign. However, the risk is not 50 contracts × $1 — it's 50 × (entry price in cents). At 90¢ entry, 50 contracts costs $45. The comment in `.env.example` (if any) and the config interface do not document the unit or the dollar risk formula. An operator enabling live trading without understanding this could size incorrectly.  
**Fix**: Add an inline comment:
```ts
// Max contracts per individual order. Each Kalshi contract pays $1 at settlement.
// Risk per trade ≈ maxPositionSize × (entryPriceCents / 100) dollars.
maxPositionSize: getEnvNumber('MAX_POSITION_SIZE', 50),
```

### BUG-L4: Coinbase WS URL is hardcoded in `loadConfig()`, not overridable
**File**: `src/config.ts` (`wsUrl: 'wss://advanced-trade-ws.coinbase.com'`)  
**Problem**: The Coinbase WS URL is a hardcoded string literal inside `loadConfig()`. If Coinbase changes their endpoint (they have done so before, migrating from `pro` to `advanced-trade`), updating requires a code change and redeploy. All other service URLs (`KALSHI_BASE_URL`) are env-configurable.  
**Fix**:
```ts
wsUrl: getEnvString('COINBASE_WS_URL', 'wss://advanced-trade-ws.coinbase.com'),
```

### BUG-L5: `paperBalanceCents` comment is misleading
**File**: `src/config.ts:130`  
**Problem**:
```ts
paperBalanceCents: getEnvNumber('PAPER_BALANCE_CENTS', 100_000), // default $1000
```
`100_000 cents = $1,000`. The comment says "$1000" which is correct but the variable name and unit (`Cents`) make the literal `100_000` confusing — a reader scanning quickly may see "100,000" and think it means $100,000.  
**Fix**: Rename to `PAPER_BALANCE_CENTS` (already done) but add an explicit clarification: `// 100_000 cents = $1,000.00`.

---

## NOTES

### N1: Coinbase advanced-trade WS auth — public ticker is fine
The `ticker` channel on `wss://advanced-trade-ws.coinbase.com` is a **public** channel and does not require JWT/API key auth for subscription. The current auth-free subscribe message is correct. Auth is only required for private channels (user orders, balances). No bug here, just confirming.

### N2: `getEnvNumber` NaN handling is correct
Unlike many codebases, this implementation throws `Error` on unparseable env vars rather than silently returning `NaN`. No silent NaN propagation risk in `config.ts` itself (except for the nested-call edge case in BUG-H1).

### N3: WS reconnect double-subscription is NOT present
`connect()` correctly calls `this.ws.removeAllListeners()` and `this.ws.terminate()` before creating a new socket. The subscription only fires in `ws.on('open', ...)`, so no double-subscription can occur on reconnect.

### N4: SIGINT/SIGTERM shutdown is clean
The shutdown sequence sets `fetchLoopActive = false`, clears both timers, disconnects the Coinbase WS, cancels open orders (live only), then exits. The signal handlers are registered after all components are initialized. Clean.

### N5: `demoKalshiUnderlyingDollars` HTML injection in dashboard
The dashboard HTML template injects `config.strategy.demoKalshiUnderlyingDollars.toFixed(2)` as a static input value. This is a price number only — no API keys, private keys, or secrets are reflected into the HTML response. No data leak here.

### N6: `botRunner.ts` / `arbStrategy.ts` not reviewed
The scope was limited to the four named files. The `runner.getState()` return shape in `/api/state` was not audited for secret leakage — recommend confirming that `BotRunner.getState()` does not include `config.kalshi.apiKeyId`, `config.kalshi.privateKeyPem`, or `config.coinbase.apiSecret` in its serialized output.
