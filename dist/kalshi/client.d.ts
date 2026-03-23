import crypto from 'crypto';
import type { KalshiMarket, KalshiOrder, KalshiOrderRequest, KalshiPosition } from './types.js';
export declare class KalshiClient {
    private readonly http;
    readonly apiKeyId: string;
    readonly privateKey: crypto.KeyObject | null;
    constructor();
    /**
     * Path used in the signature: must match Kalshi docs — full path under /trade-api/v2,
     * **without** query parameters.
     */
    private buildPathForSigning;
    /**
     * Build Kalshi authentication headers using RSA-PSS + SHA-256 (per Kalshi API key docs).
     * Payload: timestamp + METHOD + path (no body).
     */
    private buildAuthHeaders;
    /**
     * Retries a callback on HTTP 429, respecting Retry-After header.
     * Up to 3 attempts with a minimum 1s backoff.
     */
    private withRateLimitRetry;
    /**
     * Centralized error handler: logs the error and re-throws a normalized Error.
     */
    private handleError;
    /**
     * GET /markets/{ticker}
     * Returns market details including bid/ask prices in cents.
     */
    getMarket(ticker: string): Promise<KalshiMarket>;
    /**
     * GET /markets
     * Returns markets filtered by optional series ticker and status.
     */
    getMarkets(params?: {
        seriesTicker?: string;
        status?: 'open' | 'closed' | 'settled' | 'unopened' | 'paused';
        limit?: number;
    }): Promise<KalshiMarket[]>;
    /**
     * GET /portfolio/balance
     * Returns available balance in cents. In dry-run mode, returns paper balance.
     */
    getBalance(): Promise<number>;
    /**
     * GET /portfolio/positions
     * Returns all current portfolio positions.
     */
    getPositions(): Promise<KalshiPosition[]>;
    /**
     * POST /portfolio/orders
     * Places a limit buy order on Kalshi.
     */
    placeOrder(req: KalshiOrderRequest): Promise<KalshiOrder>;
    /**
     * DELETE /portfolio/orders/{orderId}
     * Cancels an open order.
     */
    cancelOrder(orderId: string): Promise<void>;
    /**
     * GET /portfolio/orders?ticker={ticker}&status=open
     * Returns all open orders for a given market ticker.
     */
    getOpenOrders(ticker: string): Promise<KalshiOrder[]>;
}
//# sourceMappingURL=client.d.ts.map