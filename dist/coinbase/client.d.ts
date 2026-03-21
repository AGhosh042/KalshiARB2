import { EventEmitter } from 'events';
export interface PricePoint {
    price: number;
    timestamp: number;
}
export type Trend = 'up' | 'down' | 'flat';
export interface CoinbasePriceData {
    price: number;
    priceChangePct: number;
    trend: Trend;
    history: PricePoint[];
}
export declare class CoinbaseClient extends EventEmitter {
    private ws;
    private priceHistory;
    private latestPrice;
    private reconnectAttempt;
    private maxReconnectDelay;
    private baseReconnectDelay;
    private isShuttingDown;
    private reconnectTimer;
    constructor();
    connect(): void;
    private subscribe;
    private handleMessage;
    private processTicker;
    private computePriceData;
    private computeTrend;
    private scheduleReconnect;
    getLatestData(): CoinbasePriceData | null;
    disconnect(): void;
}
//# sourceMappingURL=client.d.ts.map