// congress.mjs — Congressional Trading Intelligence + FMP Macro Data
// Provider: Financial Modeling Prep (FMP) — https://financialmodelingprep.com
// Free tier: 250 calls/day. Get a key at https://financialmodelingprep.com/developer/docs
// Env var required: FMP_API_KEY
//
// RATE LIMIT STRATEGY:
//   250 calls/day limit. Sweep runs every 10 min = 144 sweeps/day.
//   Daily cache (24h default): 1 refresh/day × ~5 calls = ~5 calls/day total:
//     2 calls  — Senate (stable + optional legacy fallback)
//     2 calls  — House  (stable + optional legacy fallback)
//     1 call   — Economic Calendar (FOMC/CPI/NFP/GDP upcoming)
//     1 call   — Upgrades/Downgrades (analyst calls last 3d)
//   Congressional disclosures are filed days/weeks after trades — 24h cache is safe.
//   Econ calendar changes ~weekly — 24h cache is fine.
//   Set env var CONGRESS_CACHE_HOURS to override (e.g. CONGRESS_CACHE_HOURS=12).
//
// Endpoints used (stable v2 API):
//   Senate:               https://financialmodelingprep.com/stable/senate-latest?apikey=KEY
//   House:                https://financialmodelingprep.com/stable/house-latest?apikey=KEY
//   Economic Calendar:    https://financialmodelingprep.com/stable/economic?from=DATE&to=DATE&apikey=KEY
//   Upgrades/Downgrades:  https://financialmodelingprep.com/api/v4/upgrades-downgrades?page=0&apikey=KEY
//
// Fallback to legacy v4 if stable returns nothing:
//   Senate: https://financialmodelingprep.com/api/v4/senate-trading?page=0&apikey=KEY
//   House:  https://financialmodelingprep.com/api/v4/house-trading?page=0&apikey=KEY
//
// Response fields (both chambers, flat per-trade objects):
//   senator / representative, ticker, assetDescription, type,
//   amount, transactionDate, disclosureDate, owner, district, state

import { safeFetch } from '../utils/fetch.mjs';

const BASE          = 'https://financialmodelingprep.com';
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
    senateStable:      `${BASE}/stable/senate-latest?apikey=${key}`,
    houseStable:       `${BASE}/stable/house-latest?apikey=${key}`,
    senateLegacy:      `${BASE}/api/v4/senate-trading?page=0&apikey=${key}`,
    houseLegacy:       `${BASE}/api/v4/house-trading?page=0&apikey=${key}`,
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

// ─── Normalizers ─────────────────────────────────────────────────────────────
// FMP returns flat arrays — one object per trade, no nested transactions.

function normalizeSenate(raw) {
  const ticker = (raw.ticker || '').trim().toUpperCase();
  if (!isValidTicker(ticker)) return null;
  return {
    chamber:        'Senate',
    member:         raw.senator || raw.name || 'Unknown',
    ticker,
    assetName:      raw.assetDescription || raw.asset || '',
    type:           (raw.type || '').toLowerCase(),   // 'purchase' | 'sale' | 'sale (full)' | 'sale (partial)'
    amount:         parseAmount(raw.amount),
    amountLabel:    raw.amount || '',
    date:           raw.transactionDate || raw.transaction_date || '',
    disclosureDate: raw.disclosureDate  || raw.disclosure_date  || '',
    owner:          raw.owner || 'Self',
  };
}

function normalizeHouse(raw) {
  const ticker = (raw.ticker || '').trim().toUpperCase();
  if (!isValidTicker(ticker)) return null;
  return {
    chamber:        'House',
    member:         raw.representative || raw.name || 'Unknown',
    ticker,
    assetName:      raw.assetDescription || raw.asset || '',
    type:           (raw.type || '').toLowerCase(),
    amount:         parseAmount(raw.amount),
    amountLabel:    raw.amount || '',
    date:           raw.transactionDate || raw.transaction_date || '',
    disclosureDate: raw.disclosureDate  || raw.disclosure_date  || '',
    owner:          raw.owner || 'Self',
    district:       raw.district || '',
    state:          raw.state    || '',
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

// ─── Fetch with stable → legacy fallback ─────────────────────────────────────

async function fetchChamber(stableUrl, legacyUrl, normalizer, label) {
  // Try stable endpoint first (1 API call)
  _dailyCallCount++;
  let raw = unwrap(await safeFetch(stableUrl, { timeout: 20000 }));

  // If stable returned nothing useful, try legacy (1 more API call)
  if (!raw || raw.length === 0) {
    console.warn(`[Congress] ${label} stable endpoint empty — trying legacy`);
    _dailyCallCount++;
    raw = unwrap(await safeFetch(legacyUrl, { timeout: 20000 }));
  }

  if (!raw || raw.length === 0) {
    console.warn(`[Congress] ${label} both endpoints returned no data`);
    return [];
  }

  const trades = raw
    .map(normalizer)
    .filter(t => t !== null && isRecent(t));

  console.log(`[Congress] ${label}: ${raw.length} total → ${trades.length} valid in last ${LOOKBACK_DAYS}d`);
  return trades;
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

  const ep = endpoints(key);

  const [senateTrades, houseTrades, econCalendar, upgradesDowngrades] = await Promise.all([
    fetchChamber(ep.senateStable, ep.senateLegacy, normalizeSenate, 'Senate'),
    fetchChamber(ep.houseStable,  ep.houseLegacy,  normalizeHouse,  'House'),
    fetchEconCalendar(ep),
    fetchUpgradesDowngrades(ep),
  ]);

  const allTrades  = [...senateTrades, ...houseTrades];
  const senateOk   = senateTrades.length > 0;
  const houseOk    = houseTrades.length  > 0;

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
    return {
      status:  'unavailable',
      message: 'FMP returned no valid congressional trade data.',
      houseOk, senateOk,
      topBuys: [], topSells: [], heavyHitters: [],
      insiderAlerts: [], insiderTrades: [],
      econCalendar,
      upgradesDowngrades,
      summary: 'Congressional data unavailable this cycle — no valid trades returned.',
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
    `=== CONGRESSIONAL TRADING INTEL (Last ${LOOKBACK_DAYS} days | via FMP) ===`,
    `Sources: ${houseOk ? 'House ✓' : 'House ✗'} | ${senateOk ? 'Senate ✓' : 'Senate ✗'} | ${allTrades.length} valid disclosures`,
  ].join('\n');

  return {
    status: 'ok',
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
  const key = process.env.FMP_API_KEY;
  if (!key) {
    console.warn('[Congress] FMP_API_KEY not set — skipping congressional data. Get a free key at financialmodelingprep.com');
    return {
      status:  'unconfigured',
      message: 'FMP_API_KEY not set.',
      topBuys: [], topSells: [], heavyHitters: [],
      summary: 'Congressional data unavailable — FMP_API_KEY not configured.',
    };
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

  // Cache everything except error states so a transient failure doesn't
  // wipe out valid data we already have.
  if (result.status === 'ok') {
    _cache = { result, fetchedAt: Date.now() };
  }

  return result;
}
