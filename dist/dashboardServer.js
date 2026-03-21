"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const botRunner_js_1 = require("./botRunner.js");
const config_js_1 = require("./config.js");
const logger_js_1 = __importDefault(require("./utils/logger.js"));
const client_js_1 = require("./kalshi/client.js");
/** Map thrown Kalshi client errors (message includes Axios status) to an HTTP status for the dashboard API. */
function httpStatusFromKalshiError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\[401\]|status code 401|Unauthorized/i.test(msg))
        return 401;
    if (/\[403\]|status code 403|Forbidden/i.test(msg))
        return 403;
    if (/\[404\]|status code 404|Not Found/i.test(msg))
        return 404;
    if (/\[(?:429|408)\]|status code 429|status code 408|Too Many|timeout/i.test(msg))
        return 503;
    if (/\[5\d\d\]|status code 5/i.test(msg))
        return 502;
    return null;
}
async function fetchCoinbaseBtcUsdSpot() {
    const resp = await axios_1.default.get('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
        timeout: 8_000,
    });
    const price = Number(resp.data?.price);
    if (Number.isNaN(price) || price <= 0) {
        throw new Error('Coinbase ticker response missing valid BTC-USD price');
    }
    return price;
}
const app = (0, express_1.default)();
app.use(express_1.default.json());
const runner = new botRunner_js_1.BotRunner();
app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kalshi Arb Dashboard</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 20px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
      .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; min-width: 220px; }
      label { display: block; margin-bottom: 6px; font-size: 14px; color: #444; }
      input, select, button { padding: 10px; font-size: 14px; border-radius: 8px; }
      button { cursor: pointer; }
      .btnRow { display: flex; gap: 10px; margin-top: 10px; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      th, td { border-bottom: 1px solid #eee; padding: 8px; font-size: 13px; text-align: left; }
      th { color: #444; font-weight: 600; }
      .muted { color: #666; font-size: 13px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    </style>
  </head>
  <body>
    <h1>Kalshi Arb Dashboard</h1>

    <div class="row">
      <div class="card">
        <div class="muted">Mode</div>
        <div id="modeText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="runningText" style="margin-top:6px">—</div>
      </div>
      <div class="card">
        <div class="muted">P/L</div>
        <div id="pnlText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="pnlSubText" style="margin-top:6px"></div>
      </div>
      <div class="card">
        <div class="muted">Current Trade P/L</div>
        <div id="currentTradePnLText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="currentTradePnLSubText" style="margin-top:6px"></div>
      </div>
      <div class="card">
        <div class="muted">Balance</div>
        <div id="balText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="updatedText" style="margin-top:6px"></div>
      </div>
    </div>

    <div class="row" style="margin-top:12px;">
      <div class="card">
        <div class="muted">Position</div>
        <div id="positionText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="positionSubText" style="margin-top:6px"></div>
      </div>
      <div class="card">
        <div class="muted">Open Orders</div>
        <div id="openOrdersText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="openOrdersSubText" style="margin-top:6px"></div>
      </div>
      <div class="card" style="min-width:280px;">
        <div class="muted">Cross & TP</div>
        <div id="crossText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
        <div class="muted" id="armedTpText" style="margin-top:6px"></div>
        <div class="muted" id="priceObsText" style="margin-top:6px"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px; max-width: 980px;">
      <h3 style="margin-top:0;">Run Control</h3>
      <div class="row">
        <div style="min-width: 220px;">
          <label for="modeSel">Run mode</label>
          <select id="modeSel">
            <option value="live">Live</option>
            <option value="demo">Demo</option>
          </select>
        </div>
        <div style="min-width: 260px;">
          <label for="balInput">Theoretical balance (demo only, USD)</label>
          <input id="balInput" type="number" step="1" value="1000" />
        </div>
          <div style="min-width: 260px;">
            <label for="demoUnderlyingInput">Demo underlying (BTC USD)</label>
            <input
              id="demoUnderlyingInput"
              type="number"
              step="0.01"
              value="${config_js_1.config.strategy.demoKalshiUnderlyingDollars.toFixed(2)}"
            />
          </div>
          <div style="min-width: 240px;">
            <label for="demoTargetInput">Demo target/strike (BTC USD, Kalshi)</label>
            <input
              id="demoTargetInput"
              type="number"
              step="0.01"
              disabled
              placeholder="—"
              value=""
            />
          </div>
      </div>
      <div class="btnRow">
        <button id="startBtn">Start</button>
        <button id="stopBtn" style="background:#f3f3f3;">Stop</button>
        <button id="breakevenBtn" style="background:#f3f3f3;">Close at Breakeven: OFF</button>
      </div>
      <div class="muted" id="statusText" style="margin-top:10px;"></div>
    </div>

      <div class="card" style="margin-top:16px; max-width: 980px;">
        <h3 style="margin-top:0;">Datafeed Comparison (BTC)</h3>
        <div class="row">
          <div class="card" style="min-width: 220px; border:none; padding:0; margin:0;">
            <div class="muted">Coinbase BTC</div>
            <div id="coinbasePriceText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
          </div>
          <div class="card" style="min-width: 220px; border:none; padding:0; margin:0;">
            <div class="muted">Kalshi underlying (live)</div>
            <div id="underlyingPriceText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
          </div>
          <div class="card" style="min-width: 220px; border:none; padding:0; margin:0;">
            <div class="muted">Target / strike</div>
            <div id="targetPriceText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
          </div>
        </div>
        <div class="row" style="margin-top:10px;">
          <div class="card" style="min-width: 320px; border:none; padding:0; margin:0;">
            <div class="muted">Diff (Coinbase - Underlying)</div>
            <div id="diffText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
            <div class="muted" id="diffMetaText" style="margin-top:6px"></div>
          </div>
          <div class="card" style="min-width: 280px; border:none; padding:0; margin:0;">
            <div class="muted">Coinbase direction</div>
            <div id="coinbaseDirText" style="font-size:20px;font-weight:700;margin-top:6px">—</div>
          </div>
        </div>
      </div>

    <div class="card" style="margin-top:16px; max-width: 980px;">
      <h3 style="margin-top:0;">Trade History</h3>
      <div class="muted">Last 200 trades from order placement.</div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Action</th>
            <th>Side</th>
            <th>Count</th>
            <th>Limit (¢)</th>
            <th>OrderId</th>
          </tr>
        </thead>
        <tbody id="tradesBody"></tbody>
      </table>
    </div>

    <script>
      const fmtCents = (c) => (typeof c === 'number' ? (c/100).toFixed(2) : '—');
      const fmtTime = (ms) => {
        try { return new Date(ms).toLocaleTimeString(); } catch { return '—'; }
      };

      async function api(method, path, body) {
        const res = await fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
      }

      function renderState(s) {
        document.getElementById('modeText').textContent = s?.mode ?? '—';
        document.getElementById('runningText').textContent = s?.running ? 'Running' : 'Stopped';
        document.getElementById('balText').textContent = fmtCents(s?.currentBalanceCents) ?? '—';
        const pnl = s?.pnlCents ?? null;
        if (pnl === null) {
          document.getElementById('pnlText').textContent = '—';
          document.getElementById('pnlSubText').textContent = '';
        } else {
          document.getElementById('pnlText').textContent = (pnl/100).toFixed(2) + ' $';
          document.getElementById('pnlSubText').textContent = 'Since start';
        }
        document.getElementById('updatedText').textContent = s?.updatedAt ? ('Updated ' + fmtTime(s.updatedAt)) : '';

        const posSide = s?.positionSide ?? null;
        const posContracts = s?.positionContracts ?? null;
        document.getElementById('positionText').textContent = posSide
          ? (posSide.toUpperCase() + ' (' + posContracts + ')')
          : '—';
        document.getElementById('positionSubText').textContent = '';

        document.getElementById('openOrdersText').textContent =
          s?.openOrdersCount !== undefined ? String(s.openOrdersCount) : '—';
        document.getElementById('openOrdersSubText').textContent = '';

        const crossDir = s?.lastCrossDirection ?? null;
        const crossAt = s?.lastCrossAtMs ?? null;
        document.getElementById('crossText').textContent = crossDir
          ? ('Cross ' + crossDir.toUpperCase() + (crossAt ? (' @ ' + fmtTime(crossAt)) : ''))
          : '—';

        if (s?.armedTpExitLimitCents !== null && s?.armedTpExitLimitCents !== undefined) {
          const side = s?.armedTpExitSide ?? '';
          document.getElementById('armedTpText').textContent =
            'TP armed: ' + (side ? side.toUpperCase() + ' ' : '') + '@ ' + s.armedTpExitLimitCents + '¢';
        } else {
          document.getElementById('armedTpText').textContent = 'TP armed: —';
        }

        const cb = s?.lastCoinbasePriceDollars;
        const ul = s?.lastKalshiUnderlyingPriceDollars;
        const tgt = s?.lastTargetPriceDollars;
        const parts = [];
        if (cb !== null && cb !== undefined) parts.push('Coinbase: ' + cb.toFixed(2));
        if (ul !== null && ul !== undefined) parts.push('Underlying: ' + ul.toFixed(2));
        if (tgt !== null && tgt !== undefined) parts.push('Target: ' + tgt.toFixed(2));
        document.getElementById('priceObsText').textContent = parts.length ? parts.join(' | ') : '';

        // Dedicated realtime comparison fields
        document.getElementById('coinbasePriceText').textContent =
          cb !== null && cb !== undefined ? cb.toFixed(2) : '—';
        document.getElementById('underlyingPriceText').textContent =
          ul !== null && ul !== undefined ? ul.toFixed(2) : '—';
        document.getElementById('targetPriceText').textContent =
          tgt !== null && tgt !== undefined ? tgt.toFixed(2) : '—';

        document.getElementById('coinbaseDirText').textContent =
          s?.coinbaseDirection ? s.coinbaseDirection.toUpperCase() : '—';

        const diffDollars = s?.coinbaseMinusUnderlyingDollars ?? null;
        const diffPct = s?.coinbaseMinusUnderlyingPct ?? null;
        const diffSign = s?.coinbaseMinusUnderlyingSign ?? null;
        if (diffDollars === null || diffDollars === undefined) {
          document.getElementById('diffText').textContent = '—';
          document.getElementById('diffMetaText').textContent = '';
        } else {
          document.getElementById('diffText').textContent =
            diffDollars.toFixed(2) + ' $ (' + (diffSign ? diffSign.toUpperCase() : '') + ')';
          document.getElementById('diffMetaText').textContent =
            diffPct === null || diffPct === undefined ? '' : 'Diff%: ' + diffPct.toFixed(3) + '%';
        }

        const ageMs = s?.updatedAt ? Date.now() - s.updatedAt : null;
        const ageSec = ageMs !== null ? Math.max(0, Math.floor(ageMs / 1000)) : null;
        document.getElementById('runningText').textContent =
          s?.running ? ('Running') : 'Stopped';
        document.getElementById('updatedText').textContent = s?.updatedAt
          ? ('Updated ' + fmtTime(s.updatedAt) + ' (+' + (ageSec ?? 0) + 's)')
          : '';

        // Demo-only UI: show Kalshi-derived target/strike in a read-only field.
        const demoTargetInputEl = document.getElementById('demoTargetInput');
        if (demoTargetInputEl) {
          demoTargetInputEl.value =
            tgt !== null && tgt !== undefined ? tgt.toFixed(2) : '';
        }

        const tradePnLCents = s?.currentTradePnLCents ?? null;
        const tradeMode = s?.currentTradePnLMode ?? null;
        const tradeSide = s?.currentTradeSide ?? null;
        const entryLimit = s?.currentTradeEntryLimitCents ?? null;
        const tradeCount = s?.currentTradeCount ?? null;

        if (tradePnLCents === null || tradePnLCents === undefined) {
          document.getElementById('currentTradePnLText').textContent = '—';
          document.getElementById('currentTradePnLSubText').textContent = '';
        } else {
          const sign = tradePnLCents >= 0 ? '+' : '';
          document.getElementById('currentTradePnLText').textContent =
            sign + (tradePnLCents / 100).toFixed(2) + ' $';
          const modeText = tradeMode ? tradeMode.toUpperCase() : '';
          const entryText =
            entryLimit === null || entryLimit === undefined
              ? ''
              : ' entry @ ' + entryLimit + '¢';
          const sideText = tradeSide ? ' ' + tradeSide.toUpperCase() : '';
          const countText = tradeCount !== null && tradeCount !== undefined ? ' x ' + tradeCount : '';
          document.getElementById('currentTradePnLSubText').textContent =
            (modeText ? modeText : 'TRADE') + sideText + entryText + countText;
        }
      }

      function renderTrades(trades) {
        const tbody = document.getElementById('tradesBody');
        tbody.innerHTML = '';
        for (const t of trades) {
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + fmtTime(t.timestamp) + '</td>' +
            '<td>' + t.tradeKind + '</td>' +
            '<td>' + t.orderAction + '</td>' +
            '<td>' + t.side + '</td>' +
            '<td class="mono">' + t.count + '</td>' +
            '<td class="mono">' + t.limitPriceCents + '</td>' +
            '<td class="mono">' + (t.orderId || '') + '</td>';
          tbody.appendChild(tr);
        }
      }

      let lastError = null;

      async function refresh() {
        try {
          const [s, trades] = await Promise.all([
            api('GET', '/api/state'),
            api('GET', '/api/trades')
          ]);
          lastError = null;
          renderState(s);
          renderTrades(trades);
          document.getElementById('statusText').textContent = '';
        } catch (e) {
          lastError = e;
          document.getElementById('statusText').textContent = 'Error: ' + e.message;
        }
      }

      async function seedDemoInputsFromLiveMarket() {
        try {
          const seed = await api('GET', '/api/demo-market-seed');
          const demoUnderlyingInputEl = document.getElementById('demoUnderlyingInput');
          if (demoUnderlyingInputEl && seed?.underlyingDollars !== undefined && seed?.underlyingDollars !== null) {
            demoUnderlyingInputEl.value = Number(seed.underlyingDollars).toFixed(2);
          }
          const demoTargetInputEl = document.getElementById('demoTargetInput');
          if (demoTargetInputEl && seed?.targetDollars !== undefined && seed?.targetDollars !== null) {
            demoTargetInputEl.value = Number(seed.targetDollars).toFixed(2);
          }
        } catch (e) {
          // Keep dashboard usable with static fallback if Kalshi seed fetch fails.
          document.getElementById('statusText').textContent = 'Live demo seed unavailable: ' + e.message;
        }
      }

      async function doStart() {
        const mode = document.getElementById('modeSel').value;
        const balUsd = Number(document.getElementById('balInput').value);
        const demoUnderlying = Number(document.getElementById('demoUnderlyingInput').value);
        document.getElementById('statusText').textContent = 'Starting...';
        try {
          await api('POST', '/api/start', {
            mode,
            theoreticalBalanceDollars: balUsd,
            demoUnderlyingDollars: demoUnderlying,
          });
          await refresh();
          document.getElementById('statusText').textContent = 'Started.';
        } catch (e) {
          document.getElementById('statusText').textContent = 'Start failed: ' + e.message;
        }
      }

      async function doStop() {
        document.getElementById('statusText').textContent = 'Stopping...';
        try {
          await api('POST', '/api/stop');
          await refresh();
          document.getElementById('statusText').textContent = 'Stopped.';
        } catch (e) {
          document.getElementById('statusText').textContent = 'Stop failed: ' + e.message;
        }
      }

      function updateBreakevenBtn(enabled) {
        const btn = document.getElementById('breakevenBtn');
        btn.textContent = 'Close at Breakeven: ' + (enabled ? 'ON' : 'OFF');
        btn.style.background = enabled ? '#22c55e' : '#f3f3f3';
        btn.style.color = enabled ? '#fff' : '';
      }

      async function doBreakevenToggle() {
        try {
          const data = await api('POST', '/api/breakeven-toggle');
          updateBreakevenBtn(data.breakevenCloseEnabled);
        } catch (e) {
          document.getElementById('statusText').textContent = 'Breakeven toggle failed: ' + e.message;
        }
      }

      // Keep button in sync with server state on each poll.
      const _origRenderState = renderState;
      function renderState(s) {
        _origRenderState(s);
        if (s?.breakevenCloseEnabled !== undefined) {
          updateBreakevenBtn(s.breakevenCloseEnabled);
        }
      }

      document.getElementById('startBtn').addEventListener('click', doStart);
      document.getElementById('stopBtn').addEventListener('click', doStop);
      document.getElementById('breakevenBtn').addEventListener('click', doBreakevenToggle);

      seedDemoInputsFromLiveMarket();
      refresh();
      setInterval(refresh, 1500);
    </script>
  </body>
</html>`);
});
app.get('/api/state', (_req, res) => {
    const s = runner.getState();
    res.json(s ?? {
        mode: 'demo',
        running: false,
        startBalanceCents: 0,
        currentBalanceCents: 0,
        pnlCents: 0,
        updatedAt: Date.now(),
    });
});
app.get('/api/trades', (_req, res) => {
    res.json(runner.getTrades());
});
app.get('/api/demo-market-seed', async (_req, res) => {
    const now = Date.now();
    try {
        const client = new client_js_1.KalshiClient();
        // Always discover the live ticker from the API rather than using the static config value,
        // which may point to an expired contract.
        const prefix = config_js_1.config.kalshi.marketTicker.split('-')[0].toUpperCase();
        const openMarkets = await client.getMarkets({ seriesTicker: prefix, status: 'open', limit: 100 });
        const market = openMarkets
            .filter((m) => m.close_time && new Date(m.close_time).getTime() >= now)
            .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];
        if (!market) {
            // No open market — fall back to Coinbase spot
            const spot = await fetchCoinbaseBtcUsdSpot();
            res.json({ ticker: prefix, underlyingDollars: spot, targetDollars: null, source: 'coinbase-btcusd-fallback', updatedAt: now });
            return;
        }
        // Use expiration_value_dollars (the fixed BTC strike) as the reference price.
        // last_price_dollars is often a 0-1 scale contract price — not useful here.
        const target = market.expiration_value_dollars ?? null;
        const underlying = target ?? await fetchCoinbaseBtcUsdSpot();
        res.json({
            ticker: market.ticker,
            underlyingDollars: underlying,
            targetDollars: target,
            source: target !== null ? 'kalshi-market' : 'coinbase-btcusd-fallback',
            updatedAt: now,
        });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = httpStatusFromKalshiError(e) ?? 502;
        logger_js_1.default.warn('Dashboard /api/demo-market-seed failed', { status, message });
        res.status(status).json({ error: message });
    }
});
app.post('/api/start', async (req, res) => {
    const mode = req.body?.mode;
    const theoreticalBalanceDollars = Number(req.body?.theoreticalBalanceDollars ?? 1000);
    const demoUnderlyingDollars = req.body?.demoUnderlyingDollars !== undefined ? Number(req.body.demoUnderlyingDollars) : undefined;
    const demoTargetDollars = req.body?.demoTargetDollars !== undefined ? Number(req.body.demoTargetDollars) : undefined;
    if (!mode || (mode !== 'live' && mode !== 'demo')) {
        res.status(400).json({ error: 'mode must be live|demo' });
        return;
    }
    try {
        await runner.start(mode, theoreticalBalanceDollars, demoUnderlyingDollars, demoTargetDollars);
        res.json({ ok: true });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = httpStatusFromKalshiError(e) ?? 500;
        logger_js_1.default.warn('Dashboard /api/start failed', { status, message });
        res.status(status).json({ error: message });
    }
});
app.post('/api/stop', async (_req, res) => {
    try {
        await runner.stop();
        res.json({ ok: true });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = httpStatusFromKalshiError(e) ?? 500;
        logger_js_1.default.warn('Dashboard /api/stop failed', { status, message });
        res.status(status).json({ error: message });
    }
});
app.post('/api/breakeven-toggle', (_req, res) => {
    const current = runner.isBreakevenCloseEnabled();
    runner.setBreakevenClose(!current);
    res.json({ breakevenCloseEnabled: !current });
});
const port = Number(process.env.DASHBOARD_PORT ?? 3000);
app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Dashboard listening on http://localhost:${port}`);
});
//# sourceMappingURL=dashboardServer.js.map