import crypto from 'crypto';
import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger.js';
import { config } from '../config.js';
import type {
  KalshiMarket,
  KalshiOrder,
  KalshiOrderRequest,
  KalshiPosition,
  KalshiMarketResponse,
  KalshiMarketsResponse,
  KalshiBalanceResponse,
  KalshiPositionsResponse,
  KalshiOrderResponse,
  KalshiOrdersResponse,
} from './types.js';
import { buildKalshiMarketFromRaw } from './marketNormalize.js';

export class KalshiClient {
  private readonly http: AxiosInstance;
  readonly apiKeyId: string;
  readonly privateKey: crypto.KeyObject | null;

  constructor() {
    this.apiKeyId = config.kalshi.apiKeyId;

    // Load the private key — try multiple PEM header types in case the
    // Kalshi-provided key is PKCS1 (RSA), PKCS8, or EC format.
    if (config.kalshi.privateKeyPem) {
      const pem = config.kalshi.privateKeyPem;
      const lines = pem.split('\n');
      logger.info('PEM diagnostic', {
        firstLine: lines[0],
        lastLine: lines[lines.length - 1],
        totalLines: lines.length,
        totalChars: pem.length,
      });

      // Build a list of PEM variants to try, using the base64 body from the
      // current PEM (strip existing headers so we can rewrap with alternatives).
      const b64Body = lines
        .filter(l => l && !l.startsWith('-----'))
        .join('\n');

      const candidates = [
        pem,                                                         // as-is (PKCS8)
        `-----BEGIN RSA PRIVATE KEY-----\n${b64Body}\n-----END RSA PRIVATE KEY-----`,
        `-----BEGIN EC PRIVATE KEY-----\n${b64Body}\n-----END EC PRIVATE KEY-----`,
      ];

      this.privateKey = null;
      for (const candidate of candidates) {
        try {
          this.privateKey = crypto.createPrivateKey(candidate);
          logger.info('Kalshi private key loaded successfully', {
            type: this.privateKey.asymmetricKeyType,
            header: candidate.split('\n')[0],
          });
          break;
        } catch {
          // try next format
        }
      }

      if (!this.privateKey) {
        logger.error('Failed to load Kalshi private key in any format (PKCS8, RSA PKCS1, EC). Check that KALSHI_PRIVATE_KEY_PEM is set correctly.');
        logger.error('PEM content preview', {
          first80: pem.slice(0, 80),
          last80: pem.slice(-80),
        });
      }
    } else {
      logger.warn('KALSHI_PRIVATE_KEY_PEM not set — authenticated requests will fail');
      this.privateKey = null;
    }

    this.http = axios.create({
      baseURL: config.kalshi.baseUrl,
      timeout: 20_000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    // Attach auth headers to every request via interceptor
    this.http.interceptors.request.use((reqConfig) => {
      const method = (reqConfig.method ?? 'GET').toUpperCase();
      // Build the path from url (strip the baseURL prefix)
      const fullUrl = reqConfig.url ?? '';
      // axios puts the path relative to baseURL in reqConfig.url
      // Kalshi: sign path only — no query string (see API key docs).
      const path = this.buildPathForSigning(fullUrl);
      const headers = this.buildAuthHeaders(method, path);
      Object.assign(reqConfig.headers, headers);
      return reqConfig;
    });
  }

  /**
   * Path used in the signature: must match Kalshi docs — full path under /trade-api/v2,
   * **without** query parameters.
   */
  private buildPathForSigning(urlPath: string): string {
    const noQuery = urlPath.split('?')[0] ?? urlPath;
    return noQuery.startsWith('/trade-api') ? noQuery : `/trade-api/v2${noQuery}`;
  }

  /**
   * Build Kalshi authentication headers using RSA-PSS + SHA-256 (per Kalshi API key docs).
   * Payload: timestamp + METHOD + path (no body).
   */
  private buildAuthHeaders(
    method: string,
    path: string,
  ): Record<string, string> {
    if (!this.privateKey || !this.apiKeyId) {
      return {};
    }

    const timestampMs = Date.now().toString();
    const msgToSign = `${timestampMs}${method}${path}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(msgToSign, 'utf8');
    signer.end();
    const signature = signer.sign(
      {
        key: this.privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      'base64'
    );

    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      'KALSHI-ACCESS-SIGNATURE': signature,
    };
  }

  /**
   * Retries a callback on HTTP 429, respecting Retry-After header.
   * Up to 3 attempts with a minimum 1s backoff.
   */
  private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_RETRIES = 3;
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = Number(err.response.headers['retry-after'] ?? 1);
          const delayMs = (isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000;
          logger.warn('Kalshi 429 rate limit — backing off', { attempt: attempt + 1, delayMs });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Centralized error handler: logs the error and re-throws a normalized Error.
   */
  private handleError(context: string, err: unknown): never {
    if (axios.isAxiosError(err)) {
      const axiosErr = err as AxiosError<unknown>;
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data;
      // Kalshi error bodies vary: { error: string }, { message: string },
      // or nested objects like { detail: { code, message, service } }.
      // Stringify anything that isn't already a plain string.
      const rawDetail =
        (data as any)?.detail ??
        (data as any)?.error ??
        (data as any)?.message ??
        axiosErr.message;
      const detail =
        typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
      logger.error(`Kalshi API error in ${context}`, { status, detail });
      throw new Error(`Kalshi ${context} failed [${status}]: ${detail}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Unexpected error in ${context}`, { error: msg });
    throw new Error(`Kalshi ${context} failed: ${msg}`);
  }

  /**
   * GET /markets/{ticker}
   * Returns market details including bid/ask prices in cents.
   */
  async getMarket(ticker: string): Promise<KalshiMarket> {
    try {
      const resp = await this.withRateLimitRetry(() =>
        this.http.get<KalshiMarketResponse>(`/markets/${ticker}`)
      );
      const raw = resp.data.market as Record<string, unknown>;
      return buildKalshiMarketFromRaw(raw);
    } catch (err) {
      this.handleError(`getMarket(${ticker})`, err);
    }
  }

  /**
   * GET /markets
   * Returns markets filtered by optional series ticker and status.
   */
  async getMarkets(params?: {
    seriesTicker?: string;
    status?: 'open' | 'closed' | 'settled' | 'unopened' | 'paused';
    limit?: number;
  }): Promise<KalshiMarket[]> {
    try {
      const query: Record<string, unknown> = {};
      if (params?.seriesTicker) query['series_ticker'] = params.seriesTicker;
      if (params?.status) query['status'] = params.status;
      if (params?.limit) query['limit'] = params.limit;

      const resp = await this.http.get<KalshiMarketsResponse>('/markets', {
        params: query,
      });
      return (resp.data.markets ?? []).map((raw) => buildKalshiMarketFromRaw(raw));
    } catch (err) {
      this.handleError('getMarkets', err);
    }
  }

  /**
   * GET /portfolio/balance
   * Returns available balance in cents. In dry-run mode, returns paper balance.
   */
  async getBalance(): Promise<number> {
    if (config.dryRun && config.paperBalanceCents > 0) {
      return config.paperBalanceCents;
    }
    try {
      const resp = await this.http.get<KalshiBalanceResponse>('/portfolio/balance');
      return resp.data.balance;
    } catch (err) {
      this.handleError('getBalance', err);
    }
  }

  /**
   * GET /portfolio/positions
   * Returns all current portfolio positions.
   */
  async getPositions(): Promise<KalshiPosition[]> {
    try {
      const resp = await this.withRateLimitRetry(() =>
        this.http.get<KalshiPositionsResponse>('/portfolio/positions')
      );
      return (resp.data.market_positions ?? []).map((p) => ({
        ticker: p.ticker,
        // Kalshi returns position as `position_fp` (decimal string, e.g. "31.00").
        // Fall back to `position` (integer) if present for forward-compat.
        position: p.position_fp !== undefined
          ? parseFloat(p.position_fp)
          : (p.position ?? 0),
        market_exposure: p.market_exposure_dollars !== undefined
          ? parseFloat(p.market_exposure_dollars) * 100  // dollars → cents
          : undefined,
        realized_pnl: p.realized_pnl_dollars !== undefined
          ? parseFloat(p.realized_pnl_dollars) * 100
          : undefined,
        total_traded: p.total_traded_dollars !== undefined
          ? parseFloat(p.total_traded_dollars) * 100
          : undefined,
        resting_orders_count: p.resting_orders_count,
      }));
    } catch (err) {
      this.handleError('getPositions', err);
    }
  }

  /**
   * POST /portfolio/orders
   * Places a limit buy order on Kalshi.
   */
  async placeOrder(req: KalshiOrderRequest): Promise<KalshiOrder> {
    try {
      const body: Record<string, unknown> = {
        ticker: req.ticker,
        side: req.side,
        count: req.count,
        action: req.action,
        type: req.type,
      };

      // Attach price for both limit and ioc orders — Kalshi requires exactly one price field
      // regardless of order type. IoC exit orders still need yes_price / no_price.
      if (req.type === 'limit') {
        if (req.side === 'yes' && req.yes_price !== undefined) {
          body['yes_price'] = req.yes_price;
        } else if (req.side === 'no' && req.no_price !== undefined) {
          body['no_price'] = req.no_price;
        }
      }

      if (req.expiration_ts !== undefined) {
        body['expiration_ts'] = req.expiration_ts;
      }



      const resp = await this.withRateLimitRetry(() =>
        this.http.post<KalshiOrderResponse>('/portfolio/orders', body)
      );
      const o = resp.data.order;
      const price = o.yes_price ?? o.no_price ?? 0;

      return {
        order_id: o.order_id,
        side: o.side as KalshiOrder['side'],
        count: o.count,
        price,
        status: o.status as KalshiOrder['status'],
        ticker: o.ticker,
        action: o.action as KalshiOrder['action'],
        type: o.type as KalshiOrder['type'],
        created_time: o.created_time,
        expiration_time: o.expiration_time,
        remaining_count: o.remaining_count,
        filled_count: o.filled_count,
      };
    } catch (err) {
      this.handleError('placeOrder', err);
    }
  }

  /**
   * DELETE /portfolio/orders/{orderId}
   * Cancels an open order.
   */
  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.withRateLimitRetry(() =>
        this.http.delete(`/portfolio/orders/${orderId}`)
      );
      logger.info('Cancelled Kalshi order', { orderId });
    } catch (err) {
      // 404 = order already filled/cancelled — this is not an error.
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        logger.debug('cancelOrder: order not found (already filled/cancelled)', { orderId });
        return;
      }
      this.handleError(`cancelOrder(${orderId})`, err);
    }
  }

  /**
   * GET /portfolio/orders?ticker={ticker}&status=open
   * Returns all open orders for a given market ticker.
   */
  async getOpenOrders(ticker: string): Promise<KalshiOrder[]> {
    try {
      const resp = await this.http.get<KalshiOrdersResponse>('/portfolio/orders', {
        params: {
          ticker,
          status: 'open',
        },
      });

      return (resp.data.orders ?? []).map((o) => {
        const price = o.yes_price ?? o.no_price ?? 0;
        return {
          order_id: o.order_id,
          side: o.side as KalshiOrder['side'],
          count: o.count,
          price,
          status: o.status as KalshiOrder['status'],
          ticker: o.ticker,
          action: o.action as KalshiOrder['action'],
          type: o.type as KalshiOrder['type'],
          created_time: o.created_time,
          expiration_time: o.expiration_time,
          remaining_count: o.remaining_count,
          filled_count: o.filled_count,
        };
      });
    } catch (err) {
      this.handleError(`getOpenOrders(${ticker})`, err);
    }
  }
}
