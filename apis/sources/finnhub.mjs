// Finnhub — Financial news, earnings calendar, and insider transactions
// The highest signal-density free financial API for market intelligence.
//
// What this adds:
//   • Category news (technology, mergers, general) — real-time financial headlines
//   • Earnings calendar (next 7 days) — know what binary events are coming
//   • Insider transactions for watchlist — buys flagged as high conviction
//
// Free tier: 60 req/min | No daily limit
// Get key at: https://finnhub.io/register (free, instant)
// Set FINNHUB_API_KEY in .env

import { safeFetch, today, daysAgo } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const BASE = 'https://finnhub.io/api/v1';

// News categories Finnhub supports
const NEWS_CATEGORIES = ['general', 'technology', 'merger'];

// Tickers to monitor for insider buy activity
// Focus on names where insider buys are most predictive
const INSIDER_WATCHLIST = [
  'NVDA', 'AMD', 'INTC', 'QCOM', 'AMAT', 'MU',   // semiconductors
  'MSFT', 'GOOGL', 'META', 'AAPL', 'AMZN',          // big tech
  'LMT', 'RTX', 'NOC', 'GD', 'BA', 'CACI', 'KTOS', // defense
  'MRNA', 'GILD', 'AMGN', 'REGN', 'VRTX',           // biotech
  'KMI', 'WMB', 'XOM', 'CVX',                        // energy
];

function compactNewsItem(item) {
  return {
    headline: item.headline,
    source:   item.source,
    datetime: item.datetime ? new Date(item.datetime * 1000).toISOString() : null,
    summary:  item.summary?.slice(0, 200),
    url:      item.url,
    category: item.category,
  };
}

function compactEarnings(item) {
  return {
    ticker:        item.symbol,
    date:          item.date,
    eps_estimate:  item.epsEstimate,
    revenue_est:   item.revenueEstimate,
    quarter:       item.quarter,
    year:          item.year,
  };
}

async function fetchCategoryNews(apiKey, category) {
  const params = new URLSearchParams({ category, minId: '0', token: apiKey });
  const data   = await safeFetch(`${BASE}/news?${params}`, { timeout: 10000 });
  if (!Array.isArray(data)) return [];
  // Return latest 8 items per category, newest first
  return data.slice(0, 8).map(compactNewsItem);
}

async function fetchEarningsCalendar(apiKey) {
  const from   = today();
  const to     = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; })();
  const params = new URLSearchParams({ from, to, token: apiKey });
  const data   = await safeFetch(`${BASE}/calendar/earnings?${params}`, { timeout: 10000 });
  const items  = data?.earningsCalendar || [];
  return items.slice(0, 30).map(compactEarnings); // top 30 upcoming earnings
}

async function fetchInsiderTransactions(apiKey, symbol) {
  const from   = daysAgo(5);
  const params = new URLSearchParams({ symbol, from, token: apiKey });
  const data   = await safeFetch(`${BASE}/stock/insider-transactions?${params}`, { timeout: 10000 });
  const txns   = data?.data || [];
  // Only return purchase transactions — sales are noise for entry signals
  return txns
    .filter(t => t.transactionType === 'P' || (t.change && t.change > 0))
    .map(t => ({
      ticker:     symbol,
      name:       t.name,
      shares:     t.change,
      value:      t.transactionPrice ? Math.round(t.change * t.transactionPrice) : null,
      date:       t.transactionDate,
      filing:     t.filingDate,
    }));
}

export async function briefing() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return {
      source:    'Finnhub',
      timestamp: new Date().toISOString(),
      status:    'no_key',
      message:   'Get a free key at https://finnhub.io/register — set FINNHUB_API_KEY in .env (60 req/min, no daily limit)',
    };
  }

  // ── Parallel fetch: news categories + earnings calendar ─────────────────
  const [newsResults, earnings] = await Promise.all([
    Promise.all(NEWS_CATEGORIES.map(cat => fetchCategoryNews(apiKey, cat).then(items => ({ cat, items })))),
    fetchEarningsCalendar(apiKey),
  ]);

  const newsByCategory = Object.fromEntries(newsResults.map(({ cat, items }) => [cat, items]));

  // ── Sequential insider fetch (respect 60 req/min — ~20 tickers is safe) ─
  const insiderBuys = [];
  for (const ticker of INSIDER_WATCHLIST) {
    const buys = await fetchInsiderTransactions(apiKey, ticker);
    if (buys.length > 0) insiderBuys.push(...buys);
    await new Promise(r => setTimeout(r, 200)); // ~5 req/s = well within 60/min
  }

  // ── Signal generation ────────────────────────────────────────────────────
  const signals = [];

  // News signals — headlines mentioning tickers or catalysts
  for (const [cat, items] of Object.entries(newsByCategory)) {
    for (const item of items) {
      const upper = item.headline?.toUpperCase() || '';
      const tickerHit = INSIDER_WATCHLIST.find(t => upper.includes(t));
      if (tickerHit) signals.push(`[NEWS/${cat.toUpperCase()}] ${tickerHit} — ${item.headline}`);
    }
  }

  // Earnings signals — any major name reporting within 3 days
  const soon = daysAgo(-3); // 3 days in the future
  for (const e of earnings) {
    if (INSIDER_WATCHLIST.includes(e.ticker) && e.date <= soon) {
      signals.push(`EARNINGS (${e.date}): ${e.ticker} — EPS est. ${e.eps_estimate ?? 'N/A'} | Rev est. ${e.revenue_est ?? 'N/A'}`);
    }
  }

  // Insider buy signals
  for (const b of insiderBuys) {
    const val = b.value ? `~$${(b.value / 1000).toFixed(0)}k` : '';
    signals.push(`INSIDER BUY: ${b.ticker} — ${b.name} purchased ${b.shares?.toLocaleString()} shares ${val} on ${b.date}`);
  }

  return {
    source:         'Finnhub',
    timestamp:      new Date().toISOString(),
    news:           newsByCategory,
    earnings_next7: earnings,
    insider_buys:   insiderBuys,
    signals:        signals.length > 0 ? signals : ['No high-signal Finnhub events detected this cycle'],
  };
}

if (process.argv[1]?.endsWith('finnhub.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
