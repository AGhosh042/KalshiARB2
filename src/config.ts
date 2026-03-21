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
      referencePriceDollars: getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 71052.06),
      demoKalshiUnderlyingDollars: getEnvNumber(
        'DEMO_KALSHI_UNDERLYING_DOLLARS',
        getEnvNumber('KALSHI_REFERENCE_PRICE_DOLLARS', 71052.06)
      ),
      maxPositionSize: getEnvNumber('MAX_POSITION_SIZE', 50),
      maxOpenOrders: getEnvNumber('MAX_OPEN_ORDERS', 2),
      pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 1),
      trendWindowSeconds: getEnvNumber('TREND_WINDOW_SECONDS', 30),
      orderCooldownMs: 0,
      minSecondsBeforeExpiry: 60,
      balanceFractionPerTrade: 0.05,
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
