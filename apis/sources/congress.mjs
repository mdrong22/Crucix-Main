// congress.mjs — Congressional Trading Intelligence + FMP Macro Data
//
// TRADES provider: Bargo (https://www.bargo.ai/free-apis/congress) — House + Senate STOCK Act
//   disclosures normalized into one feed. Free, keyless (30 req / 100 rows per day per IP); a free
//   BARGO_API_KEY raises it to 100 req / 1000 rows/day. Covers the last ~3 months (our lookback is 45d).
//   We migrated off FMP's senate/house endpoints because the shared FMP key 429s ("Limit Reach") in
//   normal use, which the old code silently swallowed as "no data".
//   Attribution: Bargo requires a visible "Data: Bargo (bargo.ai)" credit wherever this is shown.
//
// MACRO provider: Financial Modeling Prep (FMP) — still used ONLY for the economic calendar and
//   analyst upgrades/downgrades. Requires FMP_API_KEY; if absent or rate-limited, those two degrade
//   to empty and the congressional trades (Bargo) are unaffected.
//
// RATE LIMIT STRATEGY:
//   24h cache (default) → ~1 refresh/day: 1 Bargo call + (if FMP key) 1 econ-calendar + 1 upgrades call.
//   Congressional disclosures are filed days/weeks after trades, so a 24h cache is safe.
//   Set env var CONGRESS_CACHE_HOURS to override (e.g. CONGRESS_CACHE_HOURS=12).
//
// Bargo endpoints (base https://www.bargo.ai/free-apis/congress/v1):
//   Global trades feed:  /trades?from=DATE&to=DATE&limit=250   (both chambers, newest first)
//   Key (optional):      Authorization: Bearer <BARGO_API_KEY>
//   Trade fields: member, member_slug, chamber, state, ticker, asset, type ("purchase"|"sale"),
//                 amount_low, amount_high, amount_range, transaction_date, disclosure_date,
//                 est_price, recent_price, perf_pct, outcome, filing_portal
//
// FMP endpoints (macro only):
//   Economic Calendar:    https://financialmodelingprep.com/stable/economic?from=DATE&to=DATE&apikey=KEY
//   Upgrades/Downgrades:  https://financialmodelingprep.com/api/v4/upgrades-downgrades?page=0&apikey=KEY

import { safeFetch } from '../utils/fetch.mjs';

const BASE          = 'https://financialmodelingprep.com';
const BARGO_BASE    = 'https://www.bargo.ai/free-apis/congress/v1';
const LOOKBACK_DAYS = 45;

// ─── Known Insider Traders ────────────────────────────────────────────────────
// Members of Congress with a documented history of well-timed, committee-adjacent
// trades — flagged by STOCK Act violations, financial journalism, or academic study.
//
// Trades by anyone on this list are surfaced as PRIORITY alerts regardless of
// cluster size. A single large purchase by a committee chair is higher-conviction
// than a clustered buy by backbenchers.
//
// Key: lowercase first+last (flexible — see matchInsider()).
// Value: committee access explains WHY the trade may be predictive.
//
// Sources: STOCK Act disclosures, Unusual Whales, Capitol Trades, Quiver Quant,
//          WSJ "Conflicted Congress" series, academic SSRN studies.
const KNOWN_INSIDERS = new Map([
  // ── House ─────────────────────────────────────────────────────────────────
  ['nancy pelosi',         { display: 'Nancy Pelosi',         chamber: 'House',  committee: 'Former Speaker',         notes: 'tech/options; husband Paul trades NVDA, GOOGL, AAPL calls' }],
  ['austin scott',         { display: 'Austin Scott',         chamber: 'House',  committee: 'Armed Services',         notes: 'aviation/defense contracts; trades align with DoD awards' }],
  ['dan crenshaw',         { display: 'Dan Crenshaw',         chamber: 'House',  committee: 'Homeland Security',      notes: 'energy sector; Intel committee access' }],
  ['michael mccaul',       { display: 'Michael McCaul',       chamber: 'House',  committee: 'Foreign Affairs',        notes: 'tech investments; foreign policy = export control flow' }],
  ['josh gottheimer',      { display: 'Josh Gottheimer',      chamber: 'House',  committee: 'Intelligence',           notes: 'finance/tech; highly active, well-timed entries' }],
  ['suzan delbene',        { display: 'Suzan DelBene',        chamber: 'House',  committee: 'Ways & Means',           notes: 'former Microsoft exec; tech trades ahead of legislation' }],
  ['kevin hern',           { display: 'Kevin Hern',           chamber: 'House',  committee: 'Ways & Means/Budget',    notes: 'prolific trader; energy, restaurant, financials' }],
  ['marjorie taylor greene', { display: 'Marjorie Taylor Greene', chamber: 'House', committee: 'Oversight/Homeland', notes: 'defense, tech, NVDA options' }],
  ['ro khanna',            { display: 'Ro Khanna',            chamber: 'House',  committee: 'Armed Services',         notes: 'Silicon Valley rep; direct access to tech execs' }],
  ['virginia foxx',        { display: 'Virginia Foxx',        chamber: 'House',  committee: 'Education',              notes: 'pharma/healthcare trades; HELP committee adjacent' }],
  ['mark green',           { display: 'Mark Green',           chamber: 'House',  committee: 'Homeland Security',      notes: 'physician background; pharma/biotech timing' }],
  ['david schweikert',     { display: 'David Schweikert',     chamber: 'House',  committee: 'Ways & Means',           notes: 'high volume; finance/tech/healthcare' }],
  ['pat fallon',           { display: 'Pat Fallon',           chamber: 'House',  committee: 'Armed Services',         notes: 'defense contracts; Texas energy exposure' }],
  ['mike garcia',          { display: 'Mike Garcia',          chamber: 'House',  committee: 'Armed Services/Science', notes: 'aerospace background; defense/space plays' }],
  ['brian mast',           { display: 'Brian Mast',           chamber: 'House',  committee: 'Foreign Affairs',        notes: 'defense adjacent; Israel policy trades' }],
  ['pete sessions',        { display: 'Pete Sessions',        chamber: 'House',  committee: 'Rules',                  notes: 'rules committee = early bill visibility' }],
  ['greg murphy',          { display: 'Greg Murphy',          chamber: 'House',  committee: 'Energy & Commerce',      notes: 'physician; biotech/pharma timing' }],
  ['michael burgess',      { display: 'Michael Burgess',      chamber: 'House',  committee: 'Energy & Commerce',      notes: 'physician; healthcare/pharma' }],
  ['french hill',          { display: 'French Hill',          chamber: 'House',  committee: 'Financial Services',     notes: 'banking background; finance sector front-running' }],
  ['bill foster',          { display: 'Bill Foster',          chamber: 'House',  committee: 'Financial Services',     notes: 'physicist; tech/AI/quantum investments' }],

  // ── Senate ────────────────────────────────────────────────────────────────
  ['tommy tuberville',     { display: 'Tommy Tuberville',     chamber: 'Senate', committee: 'Armed Services',         notes: '132 STOCK Act violations; commodity/defense trades' }],
  ['shelley moore capito', { display: 'Shelley Moore Capito', chamber: 'Senate', committee: 'Appropriations',         notes: 'energy sector; WV coal→natgas transition plays' }],
  ['bill hagerty',         { display: 'Bill Hagerty',         chamber: 'Senate', committee: 'Banking/Foreign Relations', notes: 'finance sector; APAC trade policy access' }],
  ['rand paul',            { display: 'Rand Paul',            chamber: 'Senate', committee: 'Foreign Relations',      notes: 'COVID iShares sale; contrarian + policy-driven' }],
  ['john hoeven',          { display: 'John Hoeven',          chamber: 'Senate', committee: 'Appropriations',         notes: 'agriculture/energy; ND commodity exposure' }],
  ['jacky rosen',          { display: 'Jacky Rosen',          chamber: 'Senate', committee: 'Commerce/Science/Tech',  notes: 'AI/tech legislation access; semiconductor policy' }],
  ['roger marshall',       { display: 'Roger Marshall',       chamber: 'Senate', committee: 'Agriculture/Finance',    notes: 'physician; ag commodities + pharma' }],
  ['rick scott',           { display: 'Rick Scott',           chamber: 'Senate', committee: 'Armed Services/Finance', notes: 'large portfolio; healthcare/defense' }],
  ['mark kelly',           { display: 'Mark Kelly',           chamber: 'Senate', committee: 'Armed Services/Aero',    notes: 'aerospace background; space/defense' }],
  ['john curtis',          { display: 'John Curtis',          chamber: 'Senate', committee: 'Energy/Environment',     notes: 'energy transition plays; formerly active House trader' }],
]);

// Match a raw member name string against the KNOWN_INSIDERS map.
// FMP returns names as "First Last" — handles minor variations.
// Returns the matched Map key (for profile lookup) or null.
function matchInsider(memberName) {
  if (!memberName) return null;
  const lower = memberName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  for (const key of KNOWN_INSIDERS.keys()) {
    // Direct includes check covers "Nancy Pelosi" → "nancy pelosi"
    if (lower.includes(key) || key.includes(lower)) return key;
    // Word-by-word: all parts of the key appear in the name (handles middle initials)
    const parts = key.split(' ');
    if (parts.length >= 2 && parts.every(p => lower.includes(p))) return key;
  }
  return null;
}

// ─── In-Memory Cache ─────────────────────────────────────────────────────────
// Keeps FMP API usage well under the 250 calls/day free tier limit.

const CACHE_TTL_MS = (() => {
  const hours = parseFloat(process.env.CONGRESS_CACHE_HOURS || '24');
  return (isNaN(hours) || hours <= 0 ? 24 : hours) * 60 * 60 * 1000;
})();

let _cache = null;   // { result, fetchedAt: Date, callCount: number }
let _dailyCallCount = 0;
let _dailyResetAt   = Date.now();

function resetDailyCounterIfNeeded() {
  const MS_PER_DAY = 86_400_000;
  if (Date.now() - _dailyResetAt >= MS_PER_DAY) {
    _dailyCallCount = 0;
    _dailyResetAt   = Date.now();
  }
}

function cacheHit() {
  if (!_cache) return false;
  return (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS;
}

function ageLabel(ms) {
  if (ms < 60_000)   return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function endpoints(key) {
  // Econ calendar: look-ahead 14 days + look-back 2 days
  const fromDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const toDate   = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  return {
    econCalendar:      `${BASE}/stable/economic?from=${fromDate}&to=${toDate}&country=US&apikey=${key}`,
    upgradesDowngrades:`${BASE}/api/v4/upgrades-downgrades?page=0&apikey=${key}`,
  };
}

// ─── Macro Event Filters ──────────────────────────────────────────────────────
// FMP economic calendar returns every scheduled release — filter to market-moving events
const HIGH_IMPACT_EVENTS = [
  'fomc', 'federal reserve', 'interest rate', 'fed funds',
  'cpi', 'inflation', 'consumer price',
  'nfp', 'non-farm', 'nonfarm', 'payroll', 'employment',
  'gdp', 'gross domestic',
  'pce', 'personal consumption',
  'ppi', 'producer price',
  'retail sales',
  'ism manufacturing', 'ism services', 'pmi',
  'jolts', 'job openings',
  'unemployment claims', 'initial claims',
  'treasury auction', 'bond auction',
];

function isHighImpact(event = '') {
  const lower = event.toLowerCase();
  return HIGH_IMPACT_EVENTS.some(k => lower.includes(k));
}

// Tickers to track for upgrades/downgrades (our semi + macro watchlist)
const WATCH_TICKERS = new Set([
  'NVDA','AMD','INTC','QCOM','MU','AMAT','KLAC','LRCX','ASML','TSM',
  'AVGO','TXN','MRVL','AAPL','MSFT','GOOGL','META','AMZN','TSLA',
  'SPY','QQQ','SMH','SOXX','XLK','GLD','TLT','IWM',
  'BA','LMT','RTX','NOC','GD','HII',             // defense
  'XOM','CVX','SLB','HAL','COP',                  // energy
  'JPM','GS','MS','BAC','C',                       // financials
]);

async function fetchEconCalendar(ep) {
  _dailyCallCount++;
  try {
    const raw = unwrap(await safeFetch(ep.econCalendar, { timeout: 15000 }));
    if (!raw || !Array.isArray(raw)) return [];

    const events = raw
      .filter(e => e.event && (e.impact === 'High' || isHighImpact(e.event)))
      .map(e => ({
        date:     e.date     || '',
        event:    e.event    || '',
        country:  e.country  || 'US',
        impact:   e.impact   || '',
        actual:   e.actual   != null ? String(e.actual)   : null,
        estimate: e.estimate != null ? String(e.estimate) : null,
        previous: e.previous != null ? String(e.previous) : null,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Separate: upcoming (no actual yet) vs recently released
    const now       = new Date();
    const upcoming  = events.filter(e => !e.actual && new Date(e.date) >= now).slice(0, 8);
    const released  = events.filter(e =>  e.actual).slice(-5); // last 5 released

    console.log(`[Congress/EconCal] ${raw.length} events → ${events.length} high-impact, ${upcoming.length} upcoming`);
    return { upcoming, released, all: events };
  } catch (err) {
    console.warn(`[Congress/EconCal] Fetch failed: ${err.message}`);
    return { upcoming: [], released: [], all: [] };
  }
}

async function fetchUpgradesDowngrades(ep) {
  _dailyCallCount++;
  try {
    const raw = unwrap(await safeFetch(ep.upgradesDowngrades, { timeout: 15000 }));
    if (!raw || !Array.isArray(raw)) return [];

    const cutoff = new Date(Date.now() - 3 * 86_400_000); // last 3 days
    const filtered = raw
      .filter(u => {
        if (!u.symbol || !u.publishedDate) return false;
        if (!WATCH_TICKERS.has(u.symbol.toUpperCase())) return false;
        try { return new Date(u.publishedDate) >= cutoff; } catch { return false; }
      })
      .map(u => ({
        ticker:       (u.symbol          || '').toUpperCase(),
        action:       u.action           || '',   // 'upgrade' | 'downgrade' | 'initiated' | 'reiterated'
        fromGrade:    u.previousGrade    || '',
        toGrade:      u.newGrade         || '',
        analyst:      u.gradingCompany   || '',
        priceTarget:  u.priceTarget      || null,
        date:         u.publishedDate    || '',
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const upgrades   = filtered.filter(u => u.action.toLowerCase().includes('upgrade'));
    const downgrades = filtered.filter(u => u.action.toLowerCase().includes('downgrade'));

    console.log(`[Congress/Upgrades] ${raw.length} total → ${filtered.length} watchlist hits (${upgrades.length}↑ ${downgrades.length}↓) in last 3d`);
    return { all: filtered, upgrades, downgrades };
  } catch (err) {
    console.warn(`[Congress/Upgrades] Fetch failed: ${err.message}`);
    return { all: [], upgrades: [], downgrades: [] };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseAmount(amountStr = '') {
  if (!amountStr) return 0;
  const s = amountStr.toLowerCase().replace(/[$,\s]/g, '');
  const rangeMap = [
    ['over5000000',  5_000_000],
    ['1000001',      3_000_000],
    ['500001',         750_000],
    ['250001',         375_000],
    ['100001',         175_000],
    ['50001',           75_000],
    ['15001',           32_000],
    ['1001',             8_000],
  ];
  for (const [key, val] of rangeMap) {
    if (s.includes(key)) return val;
  }
  const num = parseFloat(s);
  return isNaN(num) ? 5_000 : num;
}

function isValidTicker(t) {
  if (!t) return false;
  const c = t.trim().toUpperCase();
  return c !== '--' && c !== 'N/A' && /^[A-Z]{1,5}$/.test(c);
}

function isoToDate(str) {
  if (!str) return null;
  try { return new Date(str); } catch { return null; }
}

function isRecent(trade, days = LOOKBACK_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const d = isoToDate(trade.transactionDate || trade.transaction_date || trade.date);
  return d && d >= cutoff;
}

// ─── Normalizer ──────────────────────────────────────────────────────────────
// Bargo returns one flat object per trade across both chambers.

function normalizeTrade(raw) {
  const ticker = (raw.ticker || '').trim().toUpperCase();
  if (!isValidTicker(ticker)) return null;
  // Prefer Bargo's numeric band midpoint; fall back to parsing the "$x - $y" label.
  const amount = (Number.isFinite(raw.amount_low) && Number.isFinite(raw.amount_high))
    ? Math.round((raw.amount_low + raw.amount_high) / 2)
    : parseAmount(raw.amount_range);
  return {
    chamber:        (raw.chamber || '').toLowerCase() === 'senate' ? 'Senate' : 'House',
    member:         raw.member || raw.name || 'Unknown',
    ticker,
    assetName:      raw.asset || '',
    type:           (raw.type || '').toLowerCase(),   // 'purchase' | 'sale'
    amount,
    amountLabel:    raw.amount_range || '',
    date:           raw.transaction_date || '',
    disclosureDate: raw.disclosure_date  || '',
    owner:          'Self',
    state:          raw.state || '',
    district:       '',
  };
}

// ─── Response unwrapper ───────────────────────────────────────────────────────
// Handles: raw array, { data: [] }, error objects, rawText (HTML)

function unwrap(val) {
  if (!val || val.error) return null;
  if (Array.isArray(val)) return val;
  if (Array.isArray(val.data)) return val.data;
  if (val['Error Message'] || val.message) {
    console.warn('[Congress] FMP error response:', val['Error Message'] || val.message);
    return null;
  }
  if (val.rawText) {
    console.warn('[Congress] Non-JSON response (HTML/text):', val.rawText.slice(0, 100));
    return null;
  }
  return null;
}

// ─── Bargo trades fetch ───────────────────────────────────────────────────────
// One call for the global House+Senate feed over the lookback window. A 429 is surfaced as a
// distinct rateLimited flag (NOT silently treated as "no trades"), so the caller can serve stale
// data and we can tell "throttled" apart from "genuinely empty".

async function fetchBargoTrades() {
  const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const toDate   = new Date().toISOString().slice(0, 10);
  const params   = new URLSearchParams({ from: fromDate, to: toDate, limit: '250' });
  const url      = `${BARGO_BASE}/trades?${params.toString()}`;
  const headers  = { 'User-Agent': 'Crucix/2.0 (+https://crucix.io)' };
  const key      = process.env.BARGO_API_KEY;
  if (key) headers['Authorization'] = `Bearer ${key}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers });
    if (res.status === 429) {
      // Diagnostic: a 429 on a ~once-daily call (24h cache) almost always means the key isn't loaded.
      console.warn(key
        ? `[Congress] Bargo rate-limited (429) DESPITE BARGO_API_KEY (…${String(key).slice(-4)}). Key may be invalid/expired, or the keyed daily limit (100 req/1000 rows) is exhausted.`
        : '[Congress] Bargo rate-limited (429) — no BARGO_API_KEY detected in this process. Free tier is low and shared by IP. Set BARGO_API_KEY (and restart) to raise limits.');
      return { trades: [], rateLimited: true };
    }
    if (!res.ok) {
      console.warn(`[Congress] Bargo HTTP ${res.status}`);
      return { trades: [], error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const raw  = Array.isArray(json?.trades) ? json.trades : [];
    const trades = raw.map(normalizeTrade).filter(t => t !== null && isRecent(t));
    console.log(`[Congress] Bargo: ${raw.length} disclosures → ${trades.length} valid in last ${LOOKBACK_DAYS}d${key ? '' : ' (keyless)'}`);
    return { trades };
  } catch (err) {
    console.warn(`[Congress] Bargo fetch failed: ${err.message}`);
    return { trades: [], error: err.message };
  }
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateByTicker(trades) {
  const map = {};
  for (const t of trades) {
    if (!map[t.ticker]) {
      map[t.ticker] = {
        ticker:          t.ticker,
        assetName:       t.assetName,
        purchases:       [],
        sales:           [],
        totalBuyVolume:  0,
        totalSellVolume: 0,
        members:         new Set(),
      };
    }
    const e = map[t.ticker];
    e.members.add(t.member);
    e.assetName = e.assetName || t.assetName;

    const isBuy  = t.type.includes('purchase') || t.type.includes('buy');
    const isSell = t.type.includes('sale')     || t.type.includes('sell');

    if (isBuy)  { e.purchases.push(t); e.totalBuyVolume  += t.amount; }
    if (isSell) { e.sales.push(t);     e.totalSellVolume += t.amount; }
  }

  return Object.values(map)
    .map(e => ({
      ...e,
      members:       [...e.members],
      netSentiment:  e.totalBuyVolume  - e.totalSellVolume,
      totalActivity: e.totalBuyVolume  + e.totalSellVolume,
      buyCount:      e.purchases.length,
      sellCount:     e.sales.length,
    }))
    .sort((a, b) => b.totalActivity - a.totalActivity);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function _fetchFresh(key) {
  resetDailyCounterIfNeeded();

  // Trades come from Bargo (keyless-capable). Econ calendar + analyst upgrades still come from FMP —
  // only when an FMP key is present; otherwise they degrade to empty without touching the trades.
  const ep = key ? endpoints(key) : null;

  const [bargo, econCalendar, upgradesDowngrades] = await Promise.all([
    fetchBargoTrades(),
    ep ? fetchEconCalendar(ep)      : Promise.resolve({ upcoming: [], released: [], all: [] }),
    ep ? fetchUpgradesDowngrades(ep): Promise.resolve({ all: [], upgrades: [], downgrades: [] }),
  ]);

  const allTrades  = bargo.trades;
  const senateOk   = allTrades.some(t => t.chamber === 'Senate');
  const houseOk    = allTrades.some(t => t.chamber === 'House');

  // ── Known-insider pass (runs after every FMP fetch, zero extra API calls) ──
  // Filter allTrades for members on the curated watchlist.
  // Each match is a priority alert regardless of cluster size — a single
  // large purchase by an Armed Services chair outweighs a cluster of backbenchers.
  const insiderTrades = [];
  for (const trade of allTrades) {
    const key = matchInsider(trade.member);
    if (!key) continue;
    const profile = KNOWN_INSIDERS.get(key);
    insiderTrades.push({
      ...trade,
      committee: profile?.committee || '',
      notes:     profile?.notes     || '',
    });
  }

  // Group insider trades by member for clean signal output
  const insiderAlerts = [];
  const byMember = {};
  for (const t of insiderTrades) {
    (byMember[t.member] = byMember[t.member] || []).push(t);
  }
  for (const [member, trades] of Object.entries(byMember)) {
    const profile  = KNOWN_INSIDERS.get(matchInsider(member));
    const buys     = trades.filter(t => t.type.includes('purchase') || t.type.includes('buy'));
    const sells    = trades.filter(t => t.type.includes('sale') || t.type.includes('sell'));
    const tickers  = [...new Set(trades.map(t => t.ticker))].join(', ');
    const maxAmt   = Math.max(...trades.map(t => t.amount));
    const tag      = buys.length > sells.length ? 'BUY' : sells.length > buys.length ? 'SELL' : 'MIXED';

    insiderAlerts.push({
      member,
      chamber:   trades[0].chamber,
      committee: profile?.committee || '',
      notes:     profile?.notes     || '',
      tickers,
      tradeCount:  trades.length,
      buyCount:    buys.length,
      sellCount:   sells.length,
      tag,
      maxAmount:   maxAmt,
      dateRange:   trades.map(t => t.date).sort().join(' → '),
      signal: `KNOWN INSIDER [${tag}] ${member} (${profile?.committee || trades[0].chamber}): ` +
              `${tickers} — ${trades.length} trade(s), largest ~$${(maxAmt/1000).toFixed(0)}k | ${profile?.notes || ''}`,
    });
  }

  // Sort: buys first, then by dollar amount
  insiderAlerts.sort((a, b) => {
    if (a.tag === 'BUY' && b.tag !== 'BUY') return -1;
    if (b.tag === 'BUY' && a.tag !== 'BUY') return  1;
    return b.maxAmount - a.maxAmount;
  });

  if (insiderAlerts.length > 0) {
    console.log(`[Congress] 🚨 ${insiderAlerts.length} known-insider trade(s) detected: ${insiderAlerts.map(a => `${a.member} → ${a.tickers}`).join(' | ')}`);
  }

  if (allTrades.length === 0) {
    const reason = bargo.rateLimited ? 'Bargo rate-limited (set BARGO_API_KEY)'
                 : bargo.error       ? `Bargo error: ${bargo.error}`
                 : 'no valid trades returned';
    return {
      status:  'unavailable',
      rateLimited: !!bargo.rateLimited,
      message: `Congressional trades unavailable — ${reason}.`,
      attribution: 'Data: Bargo (bargo.ai)',
      houseOk, senateOk,
      topBuys: [], topSells: [], heavyHitters: [],
      insiderAlerts: [], insiderTrades: [],
      econCalendar,
      upgradesDowngrades,
      summary: `Congressional data unavailable this cycle — ${reason}.`,
    };
  }

  const byTicker = aggregateByTicker(allTrades);

  const topBuys = byTicker
    .filter(t => t.totalBuyVolume > 0 && t.netSentiment > 0)
    .sort((a, b) => b.totalBuyVolume - a.totalBuyVolume)
    .slice(0, 10)
    .map(t => ({
      ticker:         t.ticker,
      assetName:      t.assetName,
      members:        t.members,
      memberCount:    t.members.length,
      totalBuyVolume: t.totalBuyVolume,
      buyCount:       t.buyCount,
      clustered:      t.members.length >= 2,
    }));

  const topSells = byTicker
    .filter(t => t.totalSellVolume > 0 && t.netSentiment < 0)
    .sort((a, b) => b.totalSellVolume - a.totalSellVolume)
    .slice(0, 5)
    .map(t => ({
      ticker:          t.ticker,
      members:         t.members,
      memberCount:     t.members.length,
      totalSellVolume: t.totalSellVolume,
      sellCount:       t.sellCount,
    }));

  const heavyHitters = allTrades
    .filter(t => t.amount >= 100_000 && (t.type.includes('purchase') || t.type.includes('buy')))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map(({ member, chamber, ticker, amountLabel, amount, date }) =>
      ({ member, chamber, ticker, amountLabel, amount, date }));

  const summary = [
    `=== CONGRESSIONAL TRADING INTEL (Last ${LOOKBACK_DAYS} days | via Bargo) ===`,
    `Sources: ${houseOk ? 'House ✓' : 'House ✗'} | ${senateOk ? 'Senate ✓' : 'Senate ✗'} | ${allTrades.length} valid disclosures`,
  ].join('\n');

  return {
    status: 'ok',
    attribution: 'Data: Bargo (bargo.ai)',
    houseOk, senateOk,
    totalDisclosures: allTrades.length,
    lookbackDays:     LOOKBACK_DAYS,
    topBuys, topSells, heavyHitters,
    byTicker:      byTicker.slice(0, 20),
    insiderAlerts,                          // priority: known trader watchlist hits
    insiderTrades,                          // full raw trades for known insiders
    knownInsiderCount: KNOWN_INSIDERS.size,
    econCalendar,                           // upcoming FOMC/CPI/NFP/GDP events
    upgradesDowngrades,                     // recent analyst upgrades/downgrades on watchlist
    summary,
  };
}

export async function briefing() {
  // FMP key is now OPTIONAL — Bargo provides the congressional trades keyless. The key only unlocks
  // the FMP econ calendar + analyst upgrades/downgrades; without it those two are simply empty.
  const key = process.env.FMP_API_KEY || null;
  if (!key) {
    console.warn('[Congress] FMP_API_KEY not set — econ calendar + upgrades disabled; Bargo trades still active.');
  }

  // ── Cache check ────────────────────────────────────────────────────────────
  if (cacheHit()) {
    const age = Date.now() - _cache.fetchedAt;
    console.log(`[Congress] Cache hit (age: ${ageLabel(age)}, TTL: ${ageLabel(CACHE_TTL_MS)}, FMP calls today: ~${_dailyCallCount})`);
    return { ..._cache.result, cached: true, cacheAgeMs: age };
  }

  // ── Fresh fetch ────────────────────────────────────────────────────────────
  console.log(`[Congress] Cache miss — fetching fresh data (FMP calls today so far: ~${_dailyCallCount})`);
  const result = await _fetchFresh(key);
  console.log(`[Congress] Fetch complete. FMP calls today: ~${_dailyCallCount} (limit: 250)`);

  // Cache only good results so a transient failure doesn't wipe out valid data we already have.
  if (result.status === 'ok') {
    _cache = { result, fetchedAt: Date.now() };
    return result;
  }

  // Stale-while-error: if this fetch failed (rate-limit / network) but we have prior good data,
  // serve it rather than handing the agent nothing. Better a day-old congress read than a blind spot.
  if (_cache?.result) {
    const age = Date.now() - _cache.fetchedAt;
    console.warn(`[Congress] Fresh fetch ${result.status} (${result.message || ''}) — serving stale cache (age ${ageLabel(age)}).`);
    return { ..._cache.result, stale: true, staleReason: result.message || result.status, cacheAgeMs: age };
  }

  return result;
}
