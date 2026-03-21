#!/usr/bin/env node
/**
 * Usage: npm run set-market <kalshi-market-url>
 *
 * Extracts the series prefix from a Kalshi market URL, queries the live API
 * for the currently open contract, and writes the real ticker to .env.
 *
 * Example:
 *   npm run set-market https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/kxbtc15m-26mar201745
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSign, createPrivateKey, constants } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

// Parse .env file into a key→value map
function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function buildAuthHeaders(apiKeyId, privateKey) {
  const ts = Date.now().toString();
  const msg = `${ts}GET/trade-api/v2/markets`;
  const signer = createSign('RSA-SHA256');
  signer.update(msg, 'utf8');
  signer.end();
  const sig = signer.sign(
    { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
    'base64'
  );
  return { 'KALSHI-ACCESS-KEY': apiKeyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig };
}

async function fetchOpenMarkets(baseUrl, seriesTicker, apiKeyId, privateKey) {
  const url = `${baseUrl}/markets?series_ticker=${seriesTicker}&status=open&limit=100`;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...buildAuthHeaders(apiKeyId, privateKey) };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.markets ?? [];
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npm run set-market <kalshi-market-url>');
    process.exit(1);
  }

  // Extract series prefix from the URL path (first segment after /markets/)
  const pathname = new URL(url).pathname;
  const segments = pathname.split('/').filter(Boolean);
  const marketsIdx = segments.indexOf('markets');
  const seriesSlug = marketsIdx >= 0 ? segments[marketsIdx + 1] : segments[0];
  if (!seriesSlug) {
    console.error('Could not extract series from URL:', url);
    process.exit(1);
  }
  const seriesTicker = seriesSlug.toUpperCase();

  const envText = readFileSync(envPath, 'utf8');
  const env = parseEnv(envText);

  const apiKeyId = env['KALSHI_API_KEY_ID'];
  const rawPem = env['KALSHI_PRIVATE_KEY_PEM'];
  const baseUrl = env['KALSHI_BASE_URL'] ?? 'https://api.elections.kalshi.com/trade-api/v2';

  if (!apiKeyId || !rawPem) {
    console.error('KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PEM not set in .env');
    process.exit(1);
  }

  // Load private key (try PKCS8, RSA PKCS1, EC variants)
  const b64Body = rawPem.split('\n').filter(l => l && !l.startsWith('-----')).join('\n');
  const candidates = [
    rawPem,
    `-----BEGIN PRIVATE KEY-----\n${b64Body}\n-----END PRIVATE KEY-----`,
    `-----BEGIN RSA PRIVATE KEY-----\n${b64Body}\n-----END RSA PRIVATE KEY-----`,
  ];
  let privateKey = null;
  for (const c of candidates) {
    try { privateKey = createPrivateKey(c); break; } catch { /* try next */ }
  }
  if (!privateKey) {
    console.error('Failed to load private key from .env');
    process.exit(1);
  }

  console.log(`Querying open ${seriesTicker} markets...`);
  let markets;
  try {
    markets = await fetchOpenMarkets(baseUrl, seriesTicker, apiKeyId, privateKey);
  } catch (err) {
    console.error('API call failed:', err.message);
    process.exit(1);
  }

  const now = Date.now();
  const best = markets
    .filter(m => m.ticker && m.close_time && new Date(m.close_time).getTime() >= now)
    .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];

  if (!best) {
    console.error(`No open ${seriesTicker} markets found. Try again when a contract is active.`);
    process.exit(1);
  }

  const ticker = best.ticker;
  const secsLeft = Math.round((new Date(best.close_time).getTime() - now) / 1000);
  console.log(`Found: ${ticker}  (closes in ${secsLeft}s)`);

  const updated = /^KALSHI_MARKET_TICKER=/m.test(envText)
    ? envText.replace(/^KALSHI_MARKET_TICKER=.*/m, `KALSHI_MARKET_TICKER=${ticker}`)
    : envText + `\nKALSHI_MARKET_TICKER=${ticker}\n`;

  writeFileSync(envPath, updated, 'utf8');
  console.log(`✓ KALSHI_MARKET_TICKER set to: ${ticker}`);
}

main();
