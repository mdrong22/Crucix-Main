// Benzinga — Fast financial news + Options Flow intelligence
// Optional API key: BENZINGA_API_KEY in .env
// Free tier: https://www.benzinga.com/apis/quantitative-finance/ — 500 req/month
//
// WHY THIS BEATS YAHOO:
//   Benzinga publishes analyst upgrades/downgrades and earnings previews 15-30 min
//   faster than Yahoo Finance's aggregated feed. For semiconductor stocks specifically,
//   it also carries supply-chain analyst notes that Yahoo rarely surfaces.
//
// Options Flow (requires API key):
//   Unusual options activity is one of the highest-conviction institutional signals.
//   Large dark-pool sweeps on OTM calls/puts precede major moves by 1-3 days.
//   Endpoint: /api/v1/signal/option_activity — returns recent sweeps with sentiment.
//
// Without a key: falls back to Benzinga's public RSS + EE Times RSS (semiconductor trade pub).
//
// Tickers monitored: semiconductor + AI infrastructure + key macro ETFs
// Env var: BENZINGA_API_KEY (optional)

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const SEMI_TICKERS = [
  'NVDA', 'AMD', 'INTC', 'QCOM', 'MU', 'AMAT', 'KLAC', 'LRCX', 'ASML', 'TSM',
  'AVGO', 'TXN', 'MRVL', 'ON', 'WOLF', 'SWKS', 'MPWR', 'ENTG', 'ACMR', 'ONTO',
];
const MACRO_TICKERS = ['SPY', 'QQQ', 'SMH', 'SOXX', 'XLK', 'GLD', 'SLV', 'TLT'];
const ALL_TICKERS   = [...SEMI_TICKERS, ...MACRO_TICKERS];

// Significance scoring for headline filtering
const HIGH_SIGNAL_TERMS = [
  'upgrade', 'downgrade', 'beats', 'misses', 'guidance', 'raises', 'cuts',
  'acquisition', 'merger', 'partnership', 'contract', 'grant', 'chips act',
  'export control', 'ban', 'restriction', 'layoff', 'ceo', 'earnings',
  'supply chain', 'shortage', 'inventory', 'production cut', 'capacity',
];

function scoreHeadline(title = '', summary = '') {
  const text = `${title} ${summary}`.toLowerCase();
  const hits = HIGH_SIGNAL_TERMS.filter(t => text.includes(t));
  const tickerHits = ALL_TICKERS.filter(t => text.includes(t.toLowerCase()));
  return { score: hits.length + tickerHits.length * 0.5, terms: hits, tickers: tickerHits };
}

// ── API path (requires key) ──────────────────────────────────────────────────
async function fetchBenzingaAPI(apiKey) {
  const tickers = SEMI_TICKERS.slice(0, 10).join(','); // API limit per call
  const url = `https://api.benzinga.com/api/v2/news?token=${apiKey}&tickers=${tickers}&pageSize=25&displayOutput=full`;
  const data = await safeFetch(url, { timeout: 12000 });
  if (!data || data.error || !Array.isArray(data)) return null;

  return data.map(item => ({
    title:   (item.title   || '').slice(0, 150),
    summary: (item.teaser  || item.body?.slice(0, 200) || '').replace(/<[^>]+>/g, '').slice(0, 200),
    date:    item.created  || item.updated || '',
    url:     item.url      || null,
    tickers: (item.stocks  || []).map(s => s.name).filter(Boolean),
    source:  'Benzinga',
  }));
}

// ── Options Flow (requires API key) ─────────────────────────────────────────
// Unusual options activity — large sweeps on OTM contracts signal institutional positioning.
// Sentiment: BULLISH = large call sweeps, BEARISH = large put sweeps.
// aggressor_ind: 1.0 = buyer initiated (aggressive), 0.0 = seller initiated.
const OPTIONS_WATCH_TICKERS = new Set([
  ...SEMI_TICKERS,
  'SPY','QQQ','IWM','SMH','SOXX',
  'AAPL','MSFT','GOOGL','META','AMZN','TSLA',
  'BA','LMT','RTX','NOC',         // defense
  'XOM','CVX','COP',              // energy
  'JPM','GS','MS',                // financials
  'GLD','SLV','TLT',              // macro hedges
]);

async function fetchOptionsFlow(apiKey) {
  try {
    // Fetch recent unusual options activity (last 24h)
    const url = `https://api.benzinga.com/api/v1/signal/option_activity?token=${apiKey}&pageSize=50&updated=0`;
    const data = await safeFetch(url, { timeout: 12000 });

    // Response can be { option_activity: [...] } or raw array
    const items = Array.isArray(data)
      ? data
      : (data?.option_activity || data?.data || []);

    if (!items.length) return [];

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const filtered = items
      .filter(o => {
        if (!o.ticker || !OPTIONS_WATCH_TICKERS.has((o.ticker || '').toUpperCase())) return false;
        // Only surface large sweeps — size × premium must be meaningful
        const premium = parseFloat(o.cost_basis || o.premium || 0);
        if (premium < 50_000) return false;  // ignore under $50k notional
        // Recency check
        try {
          const dt = new Date(o.date_expiration ? o.date : o.time || o.created || '');
          if (dt < cutoff) return false;
        } catch { /* include if date unreadable */ }
        return true;
      })
      .map(o => {
        const premium   = parseFloat(o.cost_basis || o.premium || 0);
        const aggressor = parseFloat(o.aggressor_ind || 0.5);
        const sentiment = (o.put_call || '').toUpperCase() === 'CALL'
          ? (aggressor >= 0.6 ? 'BULLISH' : 'NEUTRAL')
          : (aggressor >= 0.6 ? 'BEARISH' : 'NEUTRAL');
        return {
          ticker:     (o.ticker     || '').toUpperCase(),
          putCall:    (o.put_call   || '').toUpperCase(),
          strike:     o.strike_price || o.strike || null,
          expiry:     o.date_expiration || o.expiration || '',
          premium:    premium,
          premiumFmt: premium >= 1_000_000
            ? `$${(premium / 1_000_000).toFixed(1)}M`
            : `$${(premium / 1_000).toFixed(0)}k`,
          sentiment,
          aggressor,
          volume:     o.volume       || null,
          openInterest: o.open_interest || null,
          date:       o.date || o.time || '',
          type:       o.option_activity_type || '',  // 'SWEEP' | 'BLOCK' | 'SPLIT'
        };
      })
      .sort((a, b) => b.premium - a.premium);

    const bullish = filtered.filter(o => o.sentiment === 'BULLISH');
    const bearish = filtered.filter(o => o.sentiment === 'BEARISH');

    console.log(`[Benzinga/Options] ${items.length} raw → ${filtered.length} watchlist sweeps (${bullish.length}↑ ${bearish.length}↓)`);
    return { all: filtered.slice(0, 20), bullish: bullish.slice(0, 8), bearish: bearish.slice(0, 8) };
  } catch (err) {
    console.warn(`[Benzinga/Options] Fetch failed: ${err.message}`);
    return { all: [], bullish: [], bearish: [] };
  }
}

// ── RSS fallback (no key needed) ─────────────────────────────────────────────
// EE Times: semiconductor trade publication, often breaks supply-chain news first
// Benzinga public RSS: broader financial but still faster than Yahoo
async function fetchRSSFallback() {
  const feeds = [
    { url: 'https://www.eetimes.com/feed/',                  source: 'EE Times' },
    { url: 'https://www.electronicdesign.com/rss.xml',       source: 'Electronic Design' },
    { url: 'https://semiengineering.com/feed/',              source: 'SemiEngineering' },
    { url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA,AMD,INTC,MU,QCOM&region=US&lang=en-US', source: 'Yahoo Semi' },
  ];

  const results = await Promise.allSettled(
    feeds.map(async ({ url, source }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Crucix/2.0 financial-intelligence' },
        });
        clearTimeout(timer);
        if (!res.ok) return [];

        const xml  = await res.text();
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
          const block   = match[1];
          const title   = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
          const link    = (block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1] || '').trim();
          const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '').trim();
          const desc    = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
          if (title) items.push({ title: title.slice(0, 150), summary: desc, date: pubDate, url: link, source });
        }
        return items;
      } catch { return []; }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

export async function briefing() {
  const apiKey   = process.env.BENZINGA_API_KEY;
  let rawItems   = [];
  let usedApi    = false;
  let optionsFlow = { all: [], bullish: [], bearish: [] };

  if (apiKey) {
    // Run news API and options flow fetch in parallel
    const [newsResult, optionsResult] = await Promise.allSettled([
      fetchBenzingaAPI(apiKey),
      fetchOptionsFlow(apiKey),
    ]);

    if (newsResult.status === 'fulfilled' && newsResult.value?.length > 0) {
      rawItems = newsResult.value;
      usedApi  = true;
    }
    if (optionsResult.status === 'fulfilled' && optionsResult.value) {
      optionsFlow = optionsResult.value;
    }
  }

  if (!usedApi) {
    rawItems = await fetchRSSFallback();
  }

  // Score and rank
  const scored = rawItems
    .map(item => {
      const { score, terms, tickers } = scoreHeadline(item.title, item.summary);
      return { ...item, signalScore: score, signalTerms: terms, mentionedTickers: tickers };
    })
    .filter(item => item.signalScore > 0)
    .sort((a, b) => b.signalScore - a.signalScore);

  // Deduplicate by title similarity
  const seen = new Set();
  const deduped = scored.filter(item => {
    const key = item.title.slice(0, 50).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const top = deduped.slice(0, 12);

  const signals = top.slice(0, 6).map(item =>
    `[${item.source}][score=${item.signalScore.toFixed(1)}]${item.mentionedTickers.length ? `[${item.mentionedTickers.slice(0, 3).join(',')}]` : ''} ${item.title}`
  );

  // Separate upgrade/downgrade events — highest value for positioning
  const upgradeDowngrade = top.filter(item =>
    item.signalTerms.some(t => t === 'upgrade' || t === 'downgrade')
  );

  // Build options flow signals string for LLM context
  const optionSignals = [];
  for (const o of optionsFlow.bullish.slice(0, 3)) {
    optionSignals.push(`BULLISH SWEEP ${o.ticker} ${o.putCall} $${o.strike} exp ${o.expiry} ${o.premiumFmt}${o.type ? ` [${o.type}]` : ''}`);
  }
  for (const o of optionsFlow.bearish.slice(0, 3)) {
    optionSignals.push(`BEARISH SWEEP ${o.ticker} ${o.putCall} $${o.strike} exp ${o.expiry} ${o.premiumFmt}${o.type ? ` [${o.type}]` : ''}`);
  }

  return {
    source:          usedApi ? 'Benzinga API' : 'Benzinga RSS Fallback',
    timestamp:       new Date().toISOString(),
    apiActive:       usedApi,
    scanned:         rawItems.length,
    relevant:        deduped.length,
    topHeadlines:    top,
    upgradeDowngrade,
    signals:         signals.length > 0 ? signals : ['No high-signal financial headlines detected'],
    optionsFlow,                                      // unusual options activity (requires API key)
    optionSignals:   optionSignals.length > 0 ? optionSignals : [],
  };
}

if (process.argv[1]?.endsWith('benzinga.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
