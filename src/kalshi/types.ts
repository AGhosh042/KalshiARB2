/**
 * Represents a Kalshi prediction market.
 * All prices (yes_bid, yes_ask, no_bid, no_ask) are in cents (0-100).
 * A price of 55 means 55 cents = $0.55 per contract.
 * Each contract pays $1.00 if the outcome resolves in your favor.
 */
export interface KalshiMarket {
  ticker: string;
  yes_bid: number;    // cents
  yes_ask: number;    // cents
  no_bid: number;     // cents
  no_ask: number;     // cents
  // Live underlying value (BTC dollars) used as the "reference" displayed on the Kalshi market page.
  // Parsed from Kalshi's `last_price_dollars` field.
  last_price_dollars?: number;
  // Fixed target/reference value used for settlement decisions (e.g. $X in "BTC >= $X at close/expiration").
  // Parsed from Kalshi's `expiration_value` field.
  expiration_value_dollars?: number;
  volume: number;     // total contracts traded
  open_interest: number;
  status: 'open' | 'closed' | 'settled' | 'finalized';
  close_time: string; // ISO 8601 datetime string
  result?: 'yes' | 'no' | null;
}

/**
 * Represents a single order on Kalshi.
 */
export interface KalshiOrder {
  order_id: string;
  side: 'yes' | 'no';
  count: number;       // number of contracts
  price: number;       // price per contract in cents
  status: 'open' | 'filled' | 'canceled' | 'resting' | 'pending';
  ticker: string;
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  created_time?: string;
  expiration_time?: string;
  remaining_count?: number;
  filled_count?: number;
}

/**
 * Request body for placing a new order on Kalshi.
 * Prices are in cents (0-100).
 *
 * When side='yes', provide yes_price (the max cents you'll pay per contract).
 * When side='no', provide no_price (the max cents you'll pay per contract).
 */
export interface KalshiOrderRequest {
  ticker: string;
  side: 'yes' | 'no';
  count: number;
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  /** Limit only: max cents per contract. Omit for market orders. */
  yes_price?: number;
  no_price?: number;
  expiration_ts?: number; // Unix timestamp (seconds) for GTC expiration
}

/**
 * Portfolio balance returned by Kalshi.
 * available_balance is in cents.
 */
export interface KalshiBalance {
  available_balance: number; // cents
  portfolio_value?: number;  // cents
  total_value?: number;      // cents
}

/**
 * A portfolio position in a given market.
 * position > 0 means net YES contracts held.
 * position < 0 means net NO contracts held.
 */
export interface KalshiPosition {
  ticker: string;
  position: number; // net contracts: positive = YES, negative = NO
  market_exposure?: number; // cents
  realized_pnl?: number;    // cents
  total_traded?: number;    // cents
  resting_orders_count?: number;
}

/**
 * Raw API response wrapper for /markets/{ticker}
 */
export interface KalshiMarketResponse {
  market: {
    ticker: string;
    yes_bid: number;
    yes_ask: number;
    no_bid: number;
    no_ask: number;
    volume: number;
    open_interest: number;
    status: string;
    close_time: string;
    result?: string | null;
    [key: string]: unknown;
  };
}

/**
 * Raw API response wrapper for GET /markets
 */
export interface KalshiMarketsResponse {
  markets: Array<Record<string, unknown>>;
  cursor?: string;
}

/**
 * Raw API response wrapper for /portfolio/balance
 */
export interface KalshiBalanceResponse {
  balance: number; // cents
}

/**
 * Raw API response wrapper for /portfolio/positions
 * Kalshi returns position as `position_fp` (a decimal string, e.g. "31.00").
 * Positive = net YES contracts, negative = net NO contracts.
 */
export interface KalshiPositionsResponse {
  market_positions: Array<{
    ticker: string;
    position_fp?: string;           // actual field: decimal string e.g. "31.00" or "-5.00"
    position?: number;              // legacy/fallback (may be absent)
    market_exposure_dollars?: string;
    realized_pnl_dollars?: string;
    total_traded_dollars?: string;
    resting_orders_count?: number;
  }>;
  cursor?: string;
}

/**
 * Raw API response wrapper for POST /portfolio/orders
 */
export interface KalshiOrderResponse {
  order: {
    order_id: string;
    side: string;
    count: number;
    yes_price?: number;
    no_price?: number;
    status: string;
    ticker: string;
    action: string;
    type: string;
    created_time?: string;
    expiration_time?: string;
    remaining_count?: number;
    filled_count?: number;
  };
}

/**
 * Raw API response for GET /portfolio/orders
 */
export interface KalshiOrdersResponse {
  orders: Array<{
    order_id: string;
    side: string;
    count: number;
    yes_price?: number;
    no_price?: number;
    status: string;
    ticker: string;
    action: string;
    type: string;
    created_time?: string;
    expiration_time?: string;
    remaining_count?: number;
    filled_count?: number;
  }>;
  cursor?: string;
}
