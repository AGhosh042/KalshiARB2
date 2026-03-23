# Infrastructure Bug Review — wsClient / client / botRunner

Reviewed files: `src/kalshi/wsClient.ts`, `src/kalshi/client.ts`, `src/botRunner.ts`  
Also referenced: `src/kalshi/types.ts`, `src/kalshi/marketNormalize.ts`

---

## CRITICAL (breaks connectivity or causes order mistakes)

### BUG-I1: Live-mode `start()` restart skips all cleanup — double connections + double event listeners

**File**: `src/botRunner.ts:257`  
**Problem**: At the top of `start()`, cleanup is gated on `if (this.pollTimer)`. In live mode, `pollTimer` is never set (only assigned in demo mode), so calling `start('live')` a second time (e.g., dashboard restart) skips `stop()` entirely. The old `CoinbaseClient` WS and old `KalshiWsClient` are never disconnected, new ones are created on top, and the `priceUpdate` listener is added to the new client while the old client continues firing on its own. Result: duplicate strategy evaluations, potentially duplicate order placements, and indefinite memory growth.

**Fix**: Replace the pollTimer guard with a universal check:
```ts
if (this.state?.running) {
  await this.stop();
}
```
Or simply always call `await this.stop()` at the start of `start()` (safe since `stop()` early-returns if nothing is running — but see BUG-I6 for a separate issue with that guard).

---

### BUG-I2: `tryRotateMarketTicker()` has no debounce — spams 100+ REST calls in the 10s rotation window

**File**: `src/botRunner.ts:452` (market event handler), `src/botRunner.ts:481` (`tryRotateMarketTicker`)  
**Problem**: Every WS `market` tick in the 10-second pre-close window triggers `void tryRotateMarketTicker()`. Since it's `void` and there is no in-flight guard, concurrent calls pile up. Each call makes 2 REST calls (`getPositions` + `getMarkets`). If Kalshi pushes ticks at 100ms intervals that's ~100 concurrent invocations × 2 REST calls = ~200 REST requests in 10 seconds — well past any sane rate limit. The function also updates `this.currentMarketTicker` inside each concurrent call, creating a subtle race where two concurrent calls could both decide a rotation is needed and both update state.

**Fix**: Add a lock flag:
```ts
private isRotating = false;

private async tryRotateMarketTicker(): Promise<void> {
  if (this.isRotating || !this.kalshiClient) return;
  this.isRotating = true;
  try {
    // ... existing body ...
  } catch { /* best-effort */ }
  finally {
    this.isRotating = false;
  }
}
```

---

## HIGH

### BUG-I3: No pong-timeout — silent TCP drop leaks the WebSocket connection forever

**File**: `src/kalshi/wsClient.ts:131`  
**Problem**: The ping timer fires every 30s (`this.ws.ping()`), but the `pong` event is never listened to. If the server drops the TCP connection silently (no close frame), the `ws` library does not detect the hang — the `close` event never fires. The connection stays in OPEN state indefinitely. The ping timer continues to run, but pings are black-holed. The bot receives no market data and never reconnects.

**Fix**: Track the last pong and terminate if it times out:
```ts
private lastPongAt = 0;

// In the 'open' handler, after setting up pingTimer:
this.ws!.on('pong', () => { this.lastPongAt = Date.now(); });
this.lastPongAt = Date.now();

this.pingTimer = setInterval(() => {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - this.lastPongAt > 60_000) {
    // No pong in 60s — force-close to trigger reconnect
    this.ws.terminate();
    return;
  }
  this.ws.ping();
}, 30_000);
```

---

### BUG-I4: Stale market data used after ticker rotation — botRunner.latestMarket never cleared

**File**: `src/botRunner.ts:481` (`tryRotateMarketTicker`), `src/kalshi/wsClient.ts:101` (`setMarketTicker`)  
**Problem**: `kalshiWsClient.setMarketTicker(next.ticker)` correctly nulls out the internal `kalshiWsClient.latestMarket`. However, `botRunner.this.latestMarket` — the field passed to `evaluateWithMarket()` on every Coinbase tick — is **not** cleared. It still holds the expired market's data (wrong strike price, stale bid/ask). During the gap between the rotation call and the first WS tick for the new market, every Coinbase tick triggers `evaluateWithMarket()` with the wrong market, potentially causing the strategy to evaluate against an expired contract's strike.

**Fix**: After rotating the ticker, null out the local cache:
```ts
this.currentMarketTicker = next.ticker;
this.latestMarket = null;       // ← ADD THIS
if (this.state) this.state.marketTicker = next.ticker;
this.kalshiWsClient?.setMarketTicker(next.ticker);
```

---

### BUG-I5: No 429 retry — rate-limit errors cause silent order placement failure

**File**: `src/kalshi/client.ts:144` (`handleError`)  
**Problem**: `handleError` immediately re-throws all HTTP errors including 429 (rate limited). There is no retry-after logic anywhere in the client. In a live trading scenario where the rotation window generates bursts of REST calls (see BUG-I2), Kalshi can return 429, which causes `placeOrder()`, `cancelOrder()`, and `getPositions()` to throw. The calling code in `strategy` typically catches these generically and logs them, meaning orders may be silently dropped.

**Fix**: Add an Axios response interceptor that retries on 429 with the `Retry-After` header:
```ts
this.http.interceptors.response.use(undefined, async (err: AxiosError) => {
  if (err.response?.status === 429) {
    const retryAfterSecs = Number(err.response.headers['retry-after'] ?? 1);
    await new Promise(r => setTimeout(r, retryAfterSecs * 1000));
    return this.http.request(err.config!);
  }
  throw err;
});
```

---

## MEDIUM

### BUG-I6: `stop()` guard is too strict — idempotent stop fails if partially initialized

**File**: `src/botRunner.ts:514`  
**Problem**: `stop()` guards with `if (!this.coinbaseClient || !this.kalshiClient || !this.strategy) return`. If `start()` throws after creating `coinbaseClient` but before creating `strategy`, calling `stop()` returns immediately (strategy is null) and `coinbaseClient` is never disconnected. Same applies to `balanceLogTimer` and `demoCoinbaseTimer` — they are not cleared inside the guard, only after it.

**Fix**: Move the resource cleanup for timers and WS clients before the guard, or use individual null checks per resource:
```ts
async stop(): Promise<void> {
  this.kalshiFetchLoopActive = false;
  this.kalshiWsClient?.disconnect();
  this.kalshiWsClient = null;
  if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  if (this.balanceLogTimer) { clearInterval(this.balanceLogTimer); this.balanceLogTimer = null; }
  if (this.demoCoinbaseTimer) { clearInterval(this.demoCoinbaseTimer); this.demoCoinbaseTimer = null; }
  this.coinbaseClient?.disconnect();
  if (this.strategy && !config.dryRun) {
    await this.strategy.cancelAllOpenOrders();
  }
  this.state = null;
  // ... null out everything else
}
```

---

### BUG-I7: Concurrent Coinbase tick during `stop()` can attempt to place orders during cancellation

**File**: `src/botRunner.ts:520` (`stop()`)  
**Problem**: `stop()` calls `await this.strategy.cancelAllOpenOrders()` — a multi-step async operation. During this await, the Coinbase `priceUpdate` event can fire. At that point, `this.coinbaseClient`, `this.kalshiClient`, `this.strategy`, and `this.state` are all still non-null. If `this.latestMarket` is non-null, `evaluateWithMarket()` runs and could place a new order on the market that cancellation is simultaneously trying to clear. The `isEvaluating` flag only prevents two *evaluations* from overlapping — it doesn't prevent an evaluation from overlapping with a cancel.

**Fix**: Set `this.latestMarket = null` at the top of `stop()` (before cancellation) so the priceUpdate guard `if (this.latestMarket)` short-circuits:
```ts
async stop(): Promise<void> {
  if (!this.coinbaseClient || !this.kalshiClient || !this.strategy) return;
  logger.info('Stopping bot runner');
  this.latestMarket = null;   // ← prevents new evaluations from firing
  // ... rest of stop
}
```

---

### BUG-I8: `tryRotateMarketTicker()` doesn't validate that the next market has a live orderbook

**File**: `src/botRunner.ts:493`  
**Problem**: After rotating, `next` is selected purely by earliest close time. No check is performed that `next.yes_bid > 0 || next.yes_ask > 0`. A newly opened market may have zero bid/ask for the first few seconds (before market makers post). The bot subscribes to it and the strategy receives a market with all-zero prices. Depending on strategy logic, this can cause it to evaluate as "deeply out of the money" and potentially fire erroneous orders at 1-cent prices.

**Fix**: Add an orderbook validity check:
```ts
const next = openMarkets
  .filter((m) => {
    const closeMs = new Date(m.close_time).getTime();
    const hasBook = (m.yes_bid ?? 0) > 0 || (m.yes_ask ?? 0) > 0;
    return m.ticker && m.close_time && closeMs >= now && hasBook;
  })
  .sort(...)[0];
```

---

### BUG-I9: If REST market seed fails, bot operates blind indefinitely at startup (live mode)

**File**: `src/botRunner.ts:384`  
**Problem**: In live mode, if `getMarket()` fails (REST seed), `this.latestMarket` stays `null`. Coinbase ticks fire immediately after `coinbaseClient.connect()`, but the priceUpdate handler guards with `if (this.latestMarket)`, silently dropping all ticks until the first WS tick provides market data. In poor connectivity or immediately after a market rotation, this window can be seconds to minutes — during which the bot is deaf to Coinbase price movements.

**Fix**: If REST seed fails, don't wait for a spontaneous WS tick. Subscribe to the WS, and on the first `connected` event, explicitly request a snapshot or briefly retry the REST seed in a loop:
```ts
this.kalshiWsClient.on('connected', async () => {
  if (!this.latestMarket) {
    try {
      this.latestMarket = await this.kalshiClient!.getMarket(this.currentMarketTicker);
    } catch { /* WS will populate on first tick */ }
  }
});
```

---

### BUG-I10: `cancelOrder()` throws on 404 — noisy errors when trying to cancel already-filled orders

**File**: `src/kalshi/client.ts:283`  
**Problem**: `cancelOrder()` calls `handleError()` on any HTTP error, including 404. If an order was filled between when the bot saw it as open and when `cancelAllOpenOrders()` tries to cancel it (a normal race in any trading system), the DELETE returns 404 and throws. This surfaces as an error log for every filled order at bot shutdown, masks real cancel failures, and may cause `cancelAllOpenOrders()` to throw and leave the rest of the order list uncancelled.

**Fix**: Treat 404 as a no-op success in `cancelOrder()`:
```ts
async cancelOrder(orderId: string): Promise<void> {
  try {
    await this.http.delete(`/portfolio/orders/${orderId}`);
    logger.info('Cancelled Kalshi order', { orderId });
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      logger.info('Kalshi order already filled/cancelled (404)', { orderId });
      return; // benign
    }
    this.handleError(`cancelOrder(${orderId})`, err);
  }
}
```

---

### BUG-I11: WS URL construction breaks if `baseUrl` doesn't have exact `/trade-api/v2` suffix

**File**: `src/kalshi/wsClient.ts:120`  
**Problem**:
```ts
const wsUrl = config.kalshi.baseUrl
  .replace('https://', 'wss://')
  .replace('/trade-api/v2', '/trade-api/ws/v2');
```
`String.replace()` is a literal substring replace — case-sensitive, exact match. If `baseUrl` is `https://api.elections.kalshi.com/trade-api/v2/` (trailing slash), or `https://api.elections.kalshi.com` (no path), or has any casing difference, the replace silently fails and the resulting `wsUrl` is missing the `/trade-api/ws/v2` path. The WebSocket connect then hits the wrong endpoint, gets a non-101 response, and the `error` event fires — triggering infinite reconnect loop.

**Fix**: Build the WS URL from the hostname directly rather than string-replacing the REST URL:
```ts
const host = new URL(config.kalshi.baseUrl).hostname;
const wsUrl = `wss://${host}/trade-api/ws/v2`;
```

---

## LOW

### BUG-I12: `saltLength` inconsistency between `wsClient.ts` and `client.ts`

**File**: `src/kalshi/wsClient.ts:97` vs `src/kalshi/client.ts:130`  
**Problem**: `wsClient.ts` hardcodes `saltLength: 32` while `client.ts` uses `crypto.constants.RSA_PSS_SALTLEN_DIGEST` (-1, i.e., "use hash length"). For SHA-256 these are currently equivalent (32 bytes = SHA-256 digest length). However, if the key or hash algorithm ever changes, `wsClient.ts` will silently use the wrong salt length while `client.ts` correctly adapts.

**Fix**: Use `crypto.constants.RSA_PSS_SALTLEN_DIGEST` in both files.

---

### BUG-I13: Dead `spread` variable in `buildDemoMarket()`

**File**: `src/botRunner.ts:130`  
**Problem**: `const spread = 2;` is declared but never used — the actual bid/ask offsets are hardcoded as `yesMidCents - 1` / `yesMidCents + 1`. This is a dead variable that creates confusion about what the actual spread is.

**Fix**: Remove `const spread = 2;` or replace the hardcoded `1`s with `spread / 2`.

---

### BUG-I14: WS event listeners on old `WebSocket` instances are never removed

**File**: `src/kalshi/wsClient.ts:128` (`doConnect`)  
**Problem**: Each time `doConnect()` creates a new `WebSocket` and assigns it to `this.ws`, the old WebSocket's `on('open')`, `on('message')`, `on('close')`, `on('error')` listeners are never explicitly removed via `.removeAllListeners()` or `.off()`. The old WebSocket *is* closed before reassignment, so the handlers fire at most once more (the close handler), but they hold a closure over `this` (the KalshiWsClient), keeping it alive until GC. In a high-reconnect scenario, this can accumulate.

**Fix**: Before reassigning `this.ws`, remove all listeners:
```ts
if (this.ws) {
  this.ws.removeAllListeners();
  // don't call close here — this is called from the close handler
}
this.ws = new WebSocket(wsUrl, { headers });
```

---

## NOTES

### N1: `getBalance()` response field assumption
`KalshiBalanceResponse` uses `balance` as the field name. The Kalshi API v2 actually returns `available_balance` as the primary field on the balance endpoint. If `balance` is undefined in the response, `resp.data.balance` returns `undefined` (TypeScript doesn't catch this because of the forced type), and `startBalanceCents` becomes `NaN` — silently corrupting all P&L calculations. Worth adding an explicit `?? 0` guard and a warning log.

### N2: Kalshi WS message field `msg` vs `data`
The parser in `handleMessage()` reads `msg['msg']` for the ticker payload. The Kalshi WS API v2 spec should be cross-checked — if the field is named `data` instead of `msg`, no ticker events would ever be processed (silent failure, `patchAndEmit` never called). Double-check against live WS frames with a sniffer or the official Kalshi WS API changelog.

### N3: `placeOrder` falls back to `price = 0` if neither `yes_price` nor `no_price` is in response
In `placeOrder()`: `const price = o.yes_price ?? o.no_price ?? 0;`. If Kalshi somehow omits both price fields in the order response (e.g., market order confirmation), `price` is silently set to 0 in the returned `KalshiOrder`. The strategy uses `price` for P&L tracking; a 0 here will corrupt breakeven and current-trade P&L calculations.

### N4: `getPositions()` `market_exposure` conversion assumes dollar string
`market_exposure_dollars` is parsed as `parseFloat(p.market_exposure_dollars) * 100`. If Kalshi ever returns this field in cents (numeric) rather than dollars (string), the value will be multiplied by 100 again. The field name includes `_dollars` which implies the assumption is documented, but this is a brittle conversion worth adding a plausibility check on.
