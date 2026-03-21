# Kalshi ARB — BTC latency arbitrage bot

A TypeScript/Node.js bot that streams **Coinbase** BTC spot prices over a WebSocket, polls **Kalshi** for the matching binary market (e.g. short-dated BTC contracts), and runs an **intersection-based strategy**: it looks for ticks where Coinbase crosses Kalshi’s live underlying BTC price and places limit orders on Kalshi accordingly. An optional **web dashboard** can start the same logic in **live** or **demo** mode and show P/L, positions, and a live Coinbase vs. underlying comparison.

This software is for research and automation. Trading involves risk; use `DRY_RUN=true` until you understand behavior and API credentials.

---

## What runs where

| Component | Entry | Role |
|-----------|--------|------|
| **Trading bot (CLI)** | `src/index.ts` | Connects Coinbase WS + Kalshi REST, polls on an interval, evaluates `ArbStrategy`, logs to console and `kalshi-arb.log`. |
| **Dashboard** | `src/dashboardServer.ts` | Express app: HTML UI + `/api/start` / `/api/stop` / `/api/state` / `/api/trades`. Wraps `BotRunner` for **Live** (real Coinbase + Kalshi) or **Demo** (synthetic Coinbase path + simulated orders). |

You typically run **either** the CLI bot **or** the dashboard-driven runner, not both against the same account unless you intend to.

---

## How it works (short)

1. **Coinbase** — Subscribes to the Advanced Trade WebSocket (`BTC-USD`), maintains a short price history, and labels trend (up / down / flat) from `PRICE_MOVE_THRESHOLD_PCT` and `TREND_WINDOW_SECONDS`.
2. **Kalshi** — Each poll loads the configured market by `KALSHI_MARKET_TICKER`, reads `last_price_dollars` (underlying) and `expiration_value_dollars` (strike/target), and optionally **auto-rotates** the ticker near expiry when you are flat and have no pending exit/entry state.
3. **Strategy** (`src/strategy/arbStrategy.ts`) — Detects **crosses** of Coinbase vs. Kalshi underlying (sign change of `coinbase - underlying` with direction filters). Entries and exits use limit prices derived from the strike and mapped to YES/NO cents; a small state machine handles exit-then-flip sequences and timeouts (`EXIT_WAIT_TIMEOUT_MS`).

---

## Requirements

- **Node.js** 18+ (20 LTS recommended)
- **npm** (comes with Node)
- Kalshi API key + private key PEM for any **authenticated** calls (balance, orders, market data that requires signing — follow Kalshi’s current docs for your account)
- Network access to Kalshi’s trade API and Coinbase’s WebSocket

---

## Setup

### 1. Install dependencies

From the project root:

```bash
npm install
```

### 2. Environment variables

Copy the example file and edit:

```bash
cp .env.example .env
```

Load order: `dotenv` reads `.env` when the process starts (`src/config.ts`).

#### Required

| Variable | Description |
|----------|-------------|
| `KALSHI_MARKET_TICKER` | Full ticker for the Kalshi market to trade (must exist and be relevant to your strategy). |

#### Kalshi authentication

| Variable | Description |
|----------|-------------|
| `KALSHI_API_KEY_ID` | API key ID from Kalshi. |
| `KALSHI_PRIVATE_KEY_PEM` | Private key PEM for request signing. The loader accepts full PEM, or raw base64 (it will wrap PKCS#8 headers). You may use literal `\n` in a single-line env value for newlines. |

#### Coinbase

The public WebSocket feed is used for prices. `COINBASE_API_KEY` / `COINBASE_API_SECRET` are present in config for consistency with Advanced Trade; extend the client if you add authenticated REST calls.

#### Safety and defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | If `true`, orders are **not** sent to Kalshi; the strategy simulates fills and updates paper balance (`PAPER_BALANCE_CENTS`). Set to `false` only when you intend **real** orders. |
| `PAPER_BALANCE_CENTS` | `100000` | Starting paper balance in **cents** ($1000). |

#### Strategy / timing (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRICE_MOVE_THRESHOLD_PCT` | `0.05` | Minimum % move over the trend window to call direction non-flat. |
| `KALSHI_REFERENCE_PRICE_DOLLARS` | `71052.06` | Fallback reference used where the codebase still expects a configured strike; live logic prefers Kalshi’s `expiration_value_dollars`. |
| `DEMO_KALSHI_UNDERLYING_DOLLARS` | same as reference | Demo/synthetic underlying seed for dashboard demo mode. |
| `MAX_POSITION_SIZE` | `50` | Cap on contracts per sizing logic. |
| `MAX_OPEN_ORDERS` | `2` | Max open orders (live) before blocking new ones. |
| `POLL_INTERVAL_MS` | `500` | How often the main loop evaluates the strategy. |
| `TREND_WINDOW_SECONDS` | `30` | History window for Coinbase trend / % change. |
| `EXIT_WAIT_TIMEOUT_MS` | `120000` | How long to wait on a pending exit before giving up and holding. |
| `KALSHI_EDGE_THRESHOLD` | `3` | Loaded into config (tuning / logging); adjust if your fork uses it in edge checks. |

#### Logging and dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Winston level: `error`, `warn`, `info`, `debug`, etc. |
| `DASHBOARD_PORT` | `3000` | HTTP port for `npm run dashboard`. |

Logs go to **stdout** and to **`kalshi-arb.log`** in the current working directory (`src/utils/logger.ts`).

---

## How to start

### Option A — CLI bot (headless)

```bash
npm start
```

Equivalent to `tsx src/index.ts`. Press **Ctrl+C** for graceful shutdown: polling stops, Coinbase WS disconnects, and open Kalshi orders are cancelled when **not** in dry run.

### Option B — Watch mode (development)

```bash
npm run dev
```

Runs `tsx watch src/index.ts` so the process restarts on file changes.

### Option C — Web dashboard

In a separate terminal:

```bash
npm run dashboard
```

Open **http://localhost:3000** (or `http://localhost:$DASHBOARD_PORT`). Use **Run control**:

- **Live** — Real Coinbase feed and Kalshi; respects `DRY_RUN` from `.env` for whether orders are real or simulated at the strategy layer.
- **Demo** — Forces dry-run-style simulation with a synthetic Coinbase series for UI/testing; you can set a theoretical USD balance and demo underlying.

**Start** / **Stop** call the API; state refreshes every ~1.5s.

### Build (compile only)

```bash
npm run build
```

Emits JavaScript to `dist/`. Day-to-day running uses `tsx` and does not require a build.

---

## Project layout (important files)

```
src/
  index.ts              # CLI entry: Coinbase + Kalshi + ArbStrategy loop
  dashboardServer.ts    # Express + embedded HTML dashboard
  botRunner.ts          # Shared runner for dashboard (live vs demo)
  config.ts             # Env loading and defaults
  strategy/arbStrategy.ts
  coinbase/client.ts    # WebSocket client
  kalshi/client.ts      # REST + signing
  utils/logger.ts
```

---

## Operations notes

- **Market ticker** must point at a market your account can trade. Wrong or expired tickers cause fetch failures or no trades.
- **Auto-rotation** in `index.ts` / `botRunner.ts` advances the ticker pattern near close when flat; naming is derived from the prefix (e.g. `15m` → 15 minutes).
- **First live run**: keep `DRY_RUN=true`, confirm logs and dashboard behavior, then set `DRY_RUN=false` only with capital you accept to risk.

---

## License / disclaimer

This repository is provided as-is. You are responsible for compliance with Kalshi, Coinbase, and applicable laws. No warranty is implied.
