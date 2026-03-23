"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KalshiClient = void 0;
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const logger_js_1 = __importDefault(require("../utils/logger.js"));
const config_js_1 = require("../config.js");
const marketNormalize_js_1 = require("./marketNormalize.js");
class KalshiClient {
    http;
    apiKeyId;
    privateKey;
    constructor() {
        this.apiKeyId = config_js_1.config.kalshi.apiKeyId;
        // Load the private key — try multiple PEM header types in case the
        // Kalshi-provided key is PKCS1 (RSA), PKCS8, or EC format.
        if (config_js_1.config.kalshi.privateKeyPem) {
            const pem = config_js_1.config.kalshi.privateKeyPem;
            const lines = pem.split('\n');
            logger_js_1.default.info('PEM diagnostic', {
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
                pem, // as-is (PKCS8)
                `-----BEGIN RSA PRIVATE KEY-----\n${b64Body}\n-----END RSA PRIVATE KEY-----`,
                `-----BEGIN EC PRIVATE KEY-----\n${b64Body}\n-----END EC PRIVATE KEY-----`,
            ];
            this.privateKey = null;
            for (const candidate of candidates) {
                try {
                    this.privateKey = crypto_1.default.createPrivateKey(candidate);
                    logger_js_1.default.info('Kalshi private key loaded successfully', {
                        type: this.privateKey.asymmetricKeyType,
                        header: candidate.split('\n')[0],
                    });
                    break;
                }
                catch {
                    // try next format
                }
            }
            if (!this.privateKey) {
                logger_js_1.default.error('Failed to load Kalshi private key in any format (PKCS8, RSA PKCS1, EC). Check that KALSHI_PRIVATE_KEY_PEM is set correctly.');
                logger_js_1.default.error('PEM content preview', {
                    first80: pem.slice(0, 80),
                    last80: pem.slice(-80),
                });
            }
        }
        else {
            logger_js_1.default.warn('KALSHI_PRIVATE_KEY_PEM not set — authenticated requests will fail');
            this.privateKey = null;
        }
        this.http = axios_1.default.create({
            baseURL: config_js_1.config.kalshi.baseUrl,
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
    buildPathForSigning(urlPath) {
        const noQuery = urlPath.split('?')[0] ?? urlPath;
        return noQuery.startsWith('/trade-api') ? noQuery : `/trade-api/v2${noQuery}`;
    }
    /**
     * Build Kalshi authentication headers using RSA-PSS + SHA-256 (per Kalshi API key docs).
     * Payload: timestamp + METHOD + path (no body).
     */
    buildAuthHeaders(method, path) {
        if (!this.privateKey || !this.apiKeyId) {
            return {};
        }
        const timestampMs = Date.now().toString();
        const msgToSign = `${timestampMs}${method}${path}`;
        const signer = crypto_1.default.createSign('RSA-SHA256');
        signer.update(msgToSign, 'utf8');
        signer.end();
        const signature = signer.sign({
            key: this.privateKey,
            padding: crypto_1.default.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto_1.default.constants.RSA_PSS_SALTLEN_DIGEST,
        }, 'base64');
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
    async withRateLimitRetry(fn) {
        const MAX_RETRIES = 3;
        let attempt = 0;
        while (true) {
            try {
                return await fn();
            }
            catch (err) {
                if (axios_1.default.isAxiosError(err) && err.response?.status === 429 && attempt < MAX_RETRIES) {
                    const retryAfter = Number(err.response.headers['retry-after'] ?? 1);
                    const delayMs = (isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000;
                    logger_js_1.default.warn('Kalshi 429 rate limit — backing off', { attempt: attempt + 1, delayMs });
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
    handleError(context, err) {
        if (axios_1.default.isAxiosError(err)) {
            const axiosErr = err;
            const status = axiosErr.response?.status;
            const data = axiosErr.response?.data;
            // Kalshi error bodies vary: { error: string }, { message: string },
            // or nested objects like { detail: { code, message, service } }.
            // Stringify anything that isn't already a plain string.
            const rawDetail = data?.detail ??
                data?.error ??
                data?.message ??
                axiosErr.message;
            const detail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
            logger_js_1.default.error(`Kalshi API error in ${context}`, { status, detail });
            throw new Error(`Kalshi ${context} failed [${status}]: ${detail}`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger_js_1.default.error(`Unexpected error in ${context}`, { error: msg });
        throw new Error(`Kalshi ${context} failed: ${msg}`);
    }
    /**
     * GET /markets/{ticker}
     * Returns market details including bid/ask prices in cents.
     */
    async getMarket(ticker) {
        try {
            const resp = await this.withRateLimitRetry(() => this.http.get(`/markets/${ticker}`));
            const raw = resp.data.market;
            return (0, marketNormalize_js_1.buildKalshiMarketFromRaw)(raw);
        }
        catch (err) {
            this.handleError(`getMarket(${ticker})`, err);
        }
    }
    /**
     * GET /markets
     * Returns markets filtered by optional series ticker and status.
     */
    async getMarkets(params) {
        try {
            const query = {};
            if (params?.seriesTicker)
                query['series_ticker'] = params.seriesTicker;
            if (params?.status)
                query['status'] = params.status;
            if (params?.limit)
                query['limit'] = params.limit;
            const resp = await this.http.get('/markets', {
                params: query,
            });
            return (resp.data.markets ?? []).map((raw) => (0, marketNormalize_js_1.buildKalshiMarketFromRaw)(raw));
        }
        catch (err) {
            this.handleError('getMarkets', err);
        }
    }
    /**
     * GET /portfolio/balance
     * Returns available balance in cents. In dry-run mode, returns paper balance.
     */
    async getBalance() {
        if (config_js_1.config.dryRun && config_js_1.config.paperBalanceCents > 0) {
            return config_js_1.config.paperBalanceCents;
        }
        try {
            const resp = await this.http.get('/portfolio/balance');
            return resp.data.balance;
        }
        catch (err) {
            this.handleError('getBalance', err);
        }
    }
    /**
     * GET /portfolio/positions
     * Returns all current portfolio positions.
     */
    async getPositions() {
        try {
            const resp = await this.withRateLimitRetry(() => this.http.get('/portfolio/positions'));
            return (resp.data.market_positions ?? []).map((p) => ({
                ticker: p.ticker,
                // Kalshi returns position as `position_fp` (decimal string, e.g. "31.00").
                // Fall back to `position` (integer) if present for forward-compat.
                position: p.position_fp !== undefined
                    ? parseFloat(p.position_fp)
                    : (p.position ?? 0),
                market_exposure: p.market_exposure_dollars !== undefined
                    ? parseFloat(p.market_exposure_dollars) * 100 // dollars → cents
                    : undefined,
                realized_pnl: p.realized_pnl_dollars !== undefined
                    ? parseFloat(p.realized_pnl_dollars) * 100
                    : undefined,
                total_traded: p.total_traded_dollars !== undefined
                    ? parseFloat(p.total_traded_dollars) * 100
                    : undefined,
                resting_orders_count: p.resting_orders_count,
            }));
        }
        catch (err) {
            this.handleError('getPositions', err);
        }
    }
    /**
     * POST /portfolio/orders
     * Places a limit buy order on Kalshi.
     */
    async placeOrder(req) {
        try {
            const body = {
                ticker: req.ticker,
                side: req.side,
                count: req.count,
                action: req.action,
                type: req.type,
            };
            if (req.type === 'limit') {
                if (req.side === 'yes' && req.yes_price !== undefined) {
                    body['yes_price'] = req.yes_price;
                }
                else if (req.side === 'no' && req.no_price !== undefined) {
                    body['no_price'] = req.no_price;
                }
            }
            if (req.expiration_ts !== undefined) {
                body['expiration_ts'] = req.expiration_ts;
            }
            if (req.reduce_only === true) {
                body['reduce_only'] = true;
            }
            const resp = await this.withRateLimitRetry(() => this.http.post('/portfolio/orders', body));
            const o = resp.data.order;
            const price = o.yes_price ?? o.no_price ?? 0;
            return {
                order_id: o.order_id,
                side: o.side,
                count: o.count,
                price,
                status: o.status,
                ticker: o.ticker,
                action: o.action,
                type: o.type,
                created_time: o.created_time,
                expiration_time: o.expiration_time,
                remaining_count: o.remaining_count,
                filled_count: o.filled_count,
            };
        }
        catch (err) {
            this.handleError('placeOrder', err);
        }
    }
    /**
     * DELETE /portfolio/orders/{orderId}
     * Cancels an open order.
     */
    async cancelOrder(orderId) {
        try {
            await this.withRateLimitRetry(() => this.http.delete(`/portfolio/orders/${orderId}`));
            logger_js_1.default.info('Cancelled Kalshi order', { orderId });
        }
        catch (err) {
            // 404 = order already filled/cancelled — this is not an error.
            if (axios_1.default.isAxiosError(err) && err.response?.status === 404) {
                logger_js_1.default.debug('cancelOrder: order not found (already filled/cancelled)', { orderId });
                return;
            }
            this.handleError(`cancelOrder(${orderId})`, err);
        }
    }
    /**
     * GET /portfolio/orders?ticker={ticker}&status=open
     * Returns all open orders for a given market ticker.
     */
    async getOpenOrders(ticker) {
        try {
            const resp = await this.http.get('/portfolio/orders', {
                params: {
                    ticker,
                    status: 'open',
                },
            });
            return (resp.data.orders ?? []).map((o) => {
                const price = o.yes_price ?? o.no_price ?? 0;
                return {
                    order_id: o.order_id,
                    side: o.side,
                    count: o.count,
                    price,
                    status: o.status,
                    ticker: o.ticker,
                    action: o.action,
                    type: o.type,
                    created_time: o.created_time,
                    expiration_time: o.expiration_time,
                    remaining_count: o.remaining_count,
                    filled_count: o.filled_count,
                };
            });
        }
        catch (err) {
            this.handleError(`getOpenOrders(${ticker})`, err);
        }
    }
}
exports.KalshiClient = KalshiClient;
//# sourceMappingURL=client.js.map