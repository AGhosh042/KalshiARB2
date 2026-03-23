/**
 * KalshiWsClient — real-time Kalshi market data via WebSocket.
 *
 * Subscribes to the `ticker` channel (public, no auth required for market data).
 * Emits KalshiMarket objects whenever Kalshi pushes a price update.
 *
 * Replaces the REST polling loop — zero REST calls for market data,
 * push latency instead of poll latency, no rate limit consumption.
 */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { KalshiMarket } from './types.js';
export interface KalshiWsClientEvents {
    market: (market: KalshiMarket) => void;
    connected: () => void;
    disconnected: (code: number, reason: string) => void;
    error: (err: Error) => void;
}
export declare interface KalshiWsClient {
    on<K extends keyof KalshiWsClientEvents>(event: K, listener: KalshiWsClientEvents[K]): this;
    emit<K extends keyof KalshiWsClientEvents>(event: K, ...args: Parameters<KalshiWsClientEvents[K]>): boolean;
}
export declare class KalshiWsClient extends EventEmitter {
    private ws;
    private marketTicker;
    private reconnectDelayMs;
    private active;
    private pingTimer;
    private pongTimeout;
    private msgId;
    private latestMarket;
    private latestMarketTimestamp;
    private readonly apiKeyId;
    private readonly privateKey;
    constructor(marketTicker: string, privateKey: crypto.KeyObject | null, apiKeyId: string, seedMarket?: KalshiMarket);
    /** Build auth headers for the WS handshake (same signing as REST). */
    private buildAuthHeaders;
    /** Switch to a new market ticker — resubscribes on the existing connection. */
    setMarketTicker(ticker: string): void;
    /** Connect and start streaming. Reconnects automatically on disconnect. */
    connect(): void;
    private doConnect;
    private cleanup;
    private handleMessage;
    private patchAndEmit;
    /** Get the last known market state without waiting for the next tick. */
    getLatestMarket(): KalshiMarket | null;
    /** Returns ms since the last market tick was received. Used to detect stale data. */
    getUnderlyingAgeMsMs(): number;
    /** Gracefully close the connection. */
    disconnect(): void;
}
//# sourceMappingURL=wsClient.d.ts.map