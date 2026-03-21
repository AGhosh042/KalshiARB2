/**
 * Diagnostic: find currently open KXBTC15M markets on the Kalshi API.
 * Usage: npx tsx scripts/find-market.ts
 */
import 'dotenv/config';
import { KalshiClient } from '../src/kalshi/client.js';

const client = new KalshiClient();

async function main() {
  console.log('\n=== Querying open KXBTC15M markets ===\n');
  try {
    const markets = await client.getMarkets({ seriesTicker: 'KXBTC15M', status: 'open', limit: 20 });
    if (markets.length === 0) {
      console.log('No open markets returned. Trying without status filter...');
      const all = await client.getMarkets({ seriesTicker: 'KXBTC15M', limit: 10 });
      if (all.length === 0) {
        console.log('Still no markets. The series may be named differently or auth may be failing.');
      } else {
        console.log('Markets found (no status filter):');
        for (const m of all) {
          console.log(`  ticker: ${m.ticker}  status: ${m.status}  close: ${m.close_time}`);
        }
      }
      return;
    }
    const now = Date.now();
    console.log(`Found ${markets.length} open market(s):\n`);
    for (const m of markets) {
      const secsLeft = Math.round((new Date(m.close_time).getTime() - now) / 1000);
      console.log(`  ticker:    ${m.ticker}`);
      console.log(`  close:     ${m.close_time}  (${secsLeft}s from now)`);
      console.log(`  yes bid/ask: ${m.yes_bid}¢ / ${m.yes_ask}¢`);
      console.log(`  strike:    $${m.expiration_value_dollars ?? 'N/A'}`);
      console.log('');
    }

    const best = markets
      .filter(m => new Date(m.close_time).getTime() >= now)
      .sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime())[0];

    if (best) {
      console.log(`\n>>> Nearest open market: ${best.ticker}`);
      console.log(`    Run: npm run set-market -- (or just set KALSHI_MARKET_TICKER=${best.ticker} in .env)`);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
  }
}

main();
