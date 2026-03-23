import dotenv from 'dotenv';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set. See .env.example`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${raw}`);
  }
  return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function getEnvString(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export interface Config {
  kalshi: {
    apiKeyId: string;
    privateKeyPem: string;
    /** e.g. production https://api.elections.kalshi.com/trade-api/v2 or demo https://demo-api.kalshi.co/trade-api/v2 */
    baseUrl: string;
    marketTicker: string;
  };
  coinbase: {
    apiKey: string;
    apiSecret: string;
    wsUrl: string;
    productId: string;
  };
  strategy: {
    priceMoveThresholdPct: number;
    kalshiEdgeThreshold: number;
    referencePriceDollars: number;
    maxPositionSize: number;
    maxOpenOrders: number;
    pollIntervalMs: number;
    trendWindowSeconds: number;
    orderCooldownMs: number;
    minSecondsBeforeExpiry: number;
    /** Don't trade when more than this many seconds remain — too much uncertainty. */
    maxSecondsBeforeExpiry: number;
    /** BTC must be at least this % past the strike before entering (filters noise crosses). */
    displacementThresholdPct: number;
    /** Exit when position is profitable by this many cents (flat TP). Set to 0 to disable. */
    takeProfitCents: number;
    /** Exit when trade P&L reaches this fraction of cost basis (proportional TP). e.g. 0.10 = +10%. Set to 0 to disable. */
    takeProfitPct: number;
    /** Exit when position is underwater by this many cents (flat SL). Set to 0 to disable. */
    stopLossCents: number;
    /** Exit when trade P&L drops below this fraction of cost basis (proportional SL). e.g. 0.10 = -10%. Set to 0 to disable. */
    stopLossPct: number;
    /** Grace period after entry before stop loss can trigger (ms). Prevents spread from immediately firing SL. */
    stopLossGraceMs: number;
    balanceFractionPerTrade: number;
    /** After placing a limit exit, wait this long (live only); if still exposed, cancel limit and use market sells. */
    exitLimitGraceMs: number;
    /** Max time in pending exit phase before canceling and HOLD (safety net). */
    exitWaitTimeoutMs: number;
    syntheticUnderlyingAlpha: number;
    // Demo-only: synthetic Kalshi underlying used for cross detection (Coinbase vs underlying).
    // If you leave it unset, defaults to `referencePriceDollars`.
    demoKalshiUnderlyingDollars: number;
  };
  dryRun: boolean;
  paperBalanceCents: number;
}

function loadConfig(): Config {
  // Normalize PEM: handle literal \n, missing headers, spaces in base64
  const rawPem = process.env['KALSHI_PRIVATE_KEY_PEM'] ?? '';
  let normalizedPem = rawPem
    .replace(/\\n/g, '\n')       // literal \n → real newline
    .replace(/\r\n/g, '\n')      // Windows CRLF → LF
    .replace(/-----BEGIN /g, '\n-----BEGIN ')
    .replace(/-----END /g, '\n-----END ')
    .replace(/\n{2,}/g, '\n')    // collapse multiple blank lines
    .trim();

  // If there's no PEM header, wrap the raw base64 in PKCS8 headers
  if (normalizedPem && !normalizedPem.startsWith('-----')) {
    // Strip any spaces or whitespace from the raw base64
    const b64 = normalizedPem.replace(/\s+/g, '');
    // Re-chunk into 64-char lines (standard PEM format)
    const chunked = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
    normalizedPem = `-----BEGIN PRIVATE KEY-----\n${chunked}\n-----END PRIVATE KEY-----`;
  } else {
    // Strip spaces within base64 lines (keep newlines)
    normalizedPem = normalizedPem
      .split('\n')
      .map(line => line.startsWith('-----') ? line : line.replace(/ /g, ''))
      .join('\n');
  }

  // BUG-H1: Evaluate referencePriceDollars once so demoKalshiUnderlyingDollars
  // can reuse it without a nested getEnvNumber call (which would be eagerly evaluated
  // even if DEMO_KALSHI_UNDERLYING_DOLLARS is set, crashing on bad outer env var).
  const referencePriceDollars = getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 85000);

  return {
    kalshi: {
      apiKeyId: getEnvString('KALSHI_API_KEY_ID', ''),
      privateKeyPem: normalizedPem,
      baseUrl: getEnvString(
        'KALSHI_BASE_URL',
        'https://api.elections.kalshi.com/trade-api/v2'
      ),
      marketTicker: requireEnv('KALSHI_MARKET_TICKER'),
    },
    coinbase: {
      apiKey: getEnvString('COINBASE_API_KEY', ''),
      apiSecret: getEnvString('COINBASE_API_SECRET', ''),
      wsUrl: 'wss://advanced-trade-ws.coinbase.com',
      productId: 'BTC-USD',
    },
    strategy: {
      priceMoveThresholdPct: getEnvNumber('PRICE_MOVE_THRESHOLD_PCT', 0.05),
      kalshiEdgeThreshold: getEnvNumber('KALSHI_EDGE_THRESHOLD', 3),
      // Used for detecting Coinbase/market "intersection" based on the market's reference/strike price.
      // Default updated to reflect current BTC price range — override via KALSHI_REFERENCE_PRICE_DOLLARS env var.
      referencePriceDollars,
      demoKalshiUnderlyingDollars: getEnvNumber('DEMO_KALSHI_UNDERLYING_DOLLARS', referencePriceDollars),
      maxPositionSize: getEnvNumber('MAX_POSITION_SIZE', 50),
      maxOpenOrders: getEnvNumber('MAX_OPEN_ORDERS', 2),
      pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 1000),
      trendWindowSeconds: getEnvNumber('TREND_WINDOW_SECONDS', 30),
      // 45s cooldown prevents churn in choppy markets around the strike.
      orderCooldownMs: getEnvNumber('ORDER_COOLDOWN_MS', 45_000),
      // Don't trade in the last 3 minutes — Kalshi has already repriced, lag is gone.
      minSecondsBeforeExpiry: getEnvNumber('MIN_SECONDS_BEFORE_EXPIRY', 45),
      // Don't trade with more than 12 minutes left — too much uncertainty, signal is weak.
      maxSecondsBeforeExpiry: getEnvNumber('MAX_SECONDS_BEFORE_EXPIRY', 870),
      // BTC must be at least 0.15% past the strike to enter — filters noise crosses.
      displacementThresholdPct: getEnvNumber('DISPLACEMENT_THRESHOLD_PCT', 0.15),
      // Take profit when position is +10c in our favor (flat TP). Set TAKE_PROFIT_CENTS=0 to disable.
      takeProfitCents: getEnvNumber('TAKE_PROFIT_CENTS', 0),
      // Take profit when trade P&L reaches this % of cost basis. Default 10% (0.10). Set to 0 to disable.
      takeProfitPct: getEnvNumber('TAKE_PROFIT_PCT', 0.10),
      // Flat stop loss (disabled by default — proportional SL below is used instead).
      stopLossCents: getEnvNumber('STOP_LOSS_CENTS', 0),
      // Proportional stop loss: mirrors takeProfitPct for 1:1 RR. Default 10% of entry. Set to 0 to disable.
      stopLossPct: getEnvNumber('STOP_LOSS_PCT', 0.10),
      // Grace period after entry before SL can trigger. Default 20s — lets the spread settle.
      stopLossGraceMs: getEnvNumber('STOP_LOSS_GRACE_MS', 20_000),
      // BUG-H4: Was hardcoded — now env-overridable via BALANCE_FRACTION_PER_TRADE.
      balanceFractionPerTrade: getEnvNumber('BALANCE_FRACTION_PER_TRADE', 0.05),
      exitLimitGraceMs: getEnvNumber('EXIT_LIMIT_GRACE_MS', 5_000),
      // Safety cap on total time stuck in pending exit (after limit + market attempts).
      exitWaitTimeoutMs: getEnvNumber('EXIT_WAIT_TIMEOUT_MS', 120_000),
      syntheticUnderlyingAlpha: getEnvNumber('SYNTHETIC_UNDERLYING_ALPHA', 0.05),
    },
    dryRun: getEnvBoolean('DRY_RUN', true),
    paperBalanceCents: getEnvNumber('PAPER_BALANCE_CENTS', 100_000), // default $1000
  };
}

export const config = loadConfig();
