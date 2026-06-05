// Market-Wide Movers Screener — biggest losers / gainers / most active
// No API key required. Uses Yahoo Finance's predefined screener (same host as yfinance.mjs).
//
// WHY THIS MATTERS:
//   Scout's tracked price universe is tiny (~13 macro symbols). A sharp dislocation in an
//   ordinary equity or ETF (e.g. SLV crashing) is invisible unless it's already a news item.
//   The screener surfaces the day's biggest absolute movers market-wide, so Scout can detect
//   capitulation/discount entries and momentum breakouts it would otherwise miss.
//
// Source (key-free, unlimited — predefined saved screens don't require a crumb):
//   https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_losers
//   scrIds: day_losers | day_gainers | most_actives
//   Quote rows: { symbol, regularMarketChangePercent, regularMarketPrice, shortName, quoteType }
//
// No env vars required. (FMP was rejected: its screener endpoints are premium / 250-call-capped
// and shared with congress.mjs — it 429s in normal use.)

import { safeFetch } from '../utils/fetch.mjs';

const SCREENER_BASE = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const MIN_ABS_PCT = 3;     // only treat |move| >= 3% as a real dislocation/breakout
const MIN_PRICE    = 3;    // drop sub-$3 pennies (illiquid, manipulation-prone)

// Skip leveraged / inverse / volatility products — their big moves are mechanical, not signal.
const LEVERAGED_RE = /\b(2x|3x|ultra|ultrapro|inverse|bull\s*3|bear\s*3|leveraged|daily)\b/i;
const LEVERAGED_SYMBOLS = new Set([
  'TQQQ','SQQQ','SOXL','SOXS','SPXL','SPXS','TNA','TZA','UVXY','SVXY','VXX','UPRO','SPXU',
  'LABU','LABD','TMF','TMV','NUGT','DUST','JNUG','JDST','BOIL','KOLD','UCO','SCO','YINN','YANG',
  'FAS','FAZ','TECL','TECS','UDOW','SDOW','UVIX','SVIX',
]);

async function fetchScreen(scrId) {
  const url = `${SCREENER_BASE}?formatted=false&scrIds=${scrId}&count=25`;
  const data = await safeFetch(url, { timeout: 12000, headers: { 'User-Agent': UA } });
  const quotes = data?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes)) return [];
  return quotes.map(q => ({
    ticker:    String(q.symbol || '').toUpperCase().trim(),
    name:      (q.shortName || q.longName || '').slice(0, 40),
    price:     Number(q.regularMarketPrice) || 0,
    changePct: Number(q.regularMarketChangePercent) || 0,
    quoteType: q.quoteType || '',
  })).filter(r =>
    r.ticker &&
    /^[A-Z]{1,5}$/.test(r.ticker) &&            // common-stock/ETF tickers only
    r.price >= MIN_PRICE &&
    !LEVERAGED_SYMBOLS.has(r.ticker) &&
    !LEVERAGED_RE.test(r.name)
  );
}

export async function briefing() {
  const [losersRaw, gainersRaw, activeRaw] = await Promise.all([
    fetchScreen('day_losers'),
    fetchScreen('day_gainers'),
    fetchScreen('most_actives'),
  ]);

  const losers  = losersRaw
    .filter(r => r.changePct <= -MIN_ABS_PCT)
    .sort((a, b) => a.changePct - b.changePct)   // most negative first
    .slice(0, 10);
  const gainers = gainersRaw
    .filter(r => r.changePct >= MIN_ABS_PCT)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 10);
  const active  = activeRaw.slice(0, 8);

  // Compact signal strings — losers framed as potential discount/oversold entries.
  const signals = [];
  if (losers.length) {
    signals.push(`TOP LOSERS (potential capitulation/discount): ${losers.slice(0, 6).map(r => `${r.ticker} ${r.changePct.toFixed(1)}%`).join(' | ')}`);
  }
  if (gainers.length) {
    signals.push(`TOP GAINERS (momentum): ${gainers.slice(0, 6).map(r => `${r.ticker} +${r.changePct.toFixed(1)}%`).join(' | ')}`);
  }

  return {
    source:    'Market Movers (Yahoo screener)',
    timestamp: new Date().toISOString(),
    losers,
    gainers,
    active,
    signals,
  };
}

if (process.argv[1]?.endsWith('movers.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
