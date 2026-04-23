// NewsAPI.org — Financial & Tech news intelligence
// Covers 150,000+ sources including Bloomberg, Reuters, TechCrunch, WSJ.
// Used for catching AI model announcements, FDA decisions, contract awards,
// earnings surprises, and M&A activity before they hit price action.
//
// Free tier: 100 req/day, articles up to 1 month old
// Get key at: https://newsapi.org/register
// Set NEWS_API_KEY in .env

import { safeFetch, daysAgo } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const BASE = 'https://newsapi.org/v2';

// Each query targets a specific market-moving news category.
// Kept to 6 queries to stay well within free-tier limits (100 req/day,
// and sweep runs every 15 min = ~96/day before other calls).
const QUERIES = [
  {
    q:        '(NVIDIA OR NVDA OR AMD OR TSMC OR "AI chip") AND (model OR GPU OR datacenter OR inference)',
    category: 'semiconductor_ai',
    note:     'AI chip and model news — direct NVDA/AMD catalyst feed',
  },
  {
    q:        '(FDA approval OR "PDUFA date" OR "drug approved" OR "clinical trial" OR "Phase 3")',
    category: 'biotech_catalyst',
    note:     'FDA catalyst detection — pre-announcement signal',
  },
  {
    q:        '(Pentagon OR "defense contract" OR "billion contract" OR DoD OR "awarded contract")',
    category: 'defense_contract',
    note:     'Defense contract awards — LMT/RTX/NOC/BA/CACI signals',
  },
  {
    q:        '("merger" OR "acquisition" OR "takeover bid" OR "buyout") AND (billion OR deal)',
    category: 'ma_activity',
    note:     'M&A catalyst — arbitrage and sector rotation signals',
  },
  {
    q:        '("earnings beat" OR "raised guidance" OR "revenue guidance" OR "buyback") AND (stock OR shares)',
    category: 'earnings_catalyst',
    note:     'Earnings and capital allocation surprises',
  },
  {
    q:        '("large language model" OR "LLM release" OR "foundation model" OR "AI benchmark" OR "model weights")',
    category: 'ai_model_release',
    note:     'AI model announcements — NVDA compute demand catalyst',
  },
];

// Shared noise words — excluded from ticker extraction
const TICKER_NOISE = new Set([
  'AI', 'US', 'UK', 'EU', 'UN', 'CEO', 'CFO', 'CTO', 'FDA', 'DOJ', 'SEC',
  'ETF', 'GDP', 'IPO', 'NATO', 'NYSE', 'NASDAQ', 'THE', 'FOR', 'AND', 'INC',
  'LLC', 'LTD', 'NEW', 'NOW', 'ALL', 'ITS', 'THIS', 'THAT', 'WITH', 'FROM',
  'WILL', 'HAVE', 'BEEN', 'THEY', 'WERE', 'INTO', 'THAN', 'SAYS', 'SAID',
  'MORE', 'ALSO', 'JUST', 'OVER', 'AFTER', 'COULD', 'WOULD', 'WHICH',
]);

function extractTickers(text = '') {
  const matches = text.match(/\b([A-Z]{2,5})\b/g) || [];
  return [...new Set(matches.filter(t => !TICKER_NOISE.has(t) && t.length >= 2 && t.length <= 5))].slice(0, 6);
}

function compactArticle(a) {
  const body    = `${a.title || ''} ${a.description || ''}`;
  const tickers = extractTickers(body);
  return {
    title:     a.title,
    source:    a.source?.name,
    published: a.publishedAt,
    tickers,
    url:       a.url,
  };
}

export async function briefing() {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    return {
      source:    'NewsAPI',
      timestamp: new Date().toISOString(),
      status:    'no_key',
      message:   'Get a free key at https://newsapi.org/register — set NEWS_API_KEY in .env (100 req/day free)',
    };
  }

  const from = daysAgo(2); // last 48h articles
  const categories = {};
  const signals    = [];

  // Sequential with small delay to avoid bursting the free tier
  for (const { q, category, note } of QUERIES) {
    const params = new URLSearchParams({
      q,
      language:  'en',
      from,
      sortBy:    'publishedAt',
      pageSize:  '5',
      apiKey,
    });

    const data     = await safeFetch(`${BASE}/everything?${params}`, { timeout: 15000 });
    const articles = (data?.articles || []).map(compactArticle);
    categories[category] = { note, articles };

    for (const a of articles) {
      if (a.tickers.length > 0) {
        signals.push(`[${category}] ${a.tickers.join(',')} — ${a.title}`);
      }
    }

    // Respect rate limits — free tier allows burst but be safe
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    source:     'NewsAPI',
    timestamp:  new Date().toISOString(),
    window:     `last 48h`,
    categories,
    signals:    signals.length > 0 ? signals : ['No ticker-tagged news signals in current window'],
  };
}

if (process.argv[1]?.endsWith('newsapi.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
