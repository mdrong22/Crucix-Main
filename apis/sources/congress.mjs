// congress.mjs — Congressional Trading Intelligence
// Provider: Financial Modeling Prep (FMP) — https://financialmodelingprep.com
// Free tier: 250 calls/day. Get a key at https://financialmodelingprep.com/developer/docs
// Env var required: FMP_API_KEY
//
// Endpoints used (stable v2 API — flat array responses, no nesting):
//   Senate: https://financialmodelingprep.com/stable/senate-latest?apikey=KEY
//   House:  https://financialmodelingprep.com/stable/house-latest?apikey=KEY
//
// Fallback to legacy v4 if stable returns nothing:
//   Senate: https://financialmodelingprep.com/api/v4/senate-trading?page=0&apikey=KEY
//   House:  https://financialmodelingprep.com/api/v4/house-trading?page=0&apikey=KEY
//
// Response fields (both chambers, flat per-trade objects):
//   senator / representative, ticker, assetDescription, type,
//   amount, transactionDate, disclosureDate, owner, district, state

import { safeFetch } from '../utils/fetch.mjs';

const BASE      = 'https://financialmodelingprep.com';
const LOOKBACK_DAYS = 45;

function endpoints(key) {
  return {
    senateStable:  `${BASE}/stable/senate-latest?apikey=${key}`,
    houseStable:   `${BASE}/stable/house-latest?apikey=${key}`,
    senateLegacy:  `${BASE}/api/v4/senate-trading?page=0&apikey=${key}`,
    houseLegacy:   `${BASE}/api/v4/house-trading?page=0&apikey=${key}`,
  };
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
  // Try stable endpoint first
  let raw = unwrap(await safeFetch(stableUrl, { timeout: 20000 }));

  // If stable returned nothing useful, try legacy
  if (!raw || raw.length === 0) {
    console.warn(`[Congress] ${label} stable endpoint empty — trying legacy`);
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

  const ep = endpoints(key);

  const [senateTrades, houseTrades] = await Promise.all([
    fetchChamber(ep.senateStable, ep.senateLegacy, normalizeSenate, 'Senate'),
    fetchChamber(ep.houseStable,  ep.houseLegacy,  normalizeHouse,  'House'),
  ]);

  const allTrades  = [...senateTrades, ...houseTrades];
  const senateOk   = senateTrades.length > 0;
  const houseOk    = houseTrades.length  > 0;

  if (allTrades.length === 0) {
    return {
      status:  'unavailable',
      message: 'FMP returned no valid congressional trade data.',
      houseOk, senateOk,
      topBuys: [], topSells: [], heavyHitters: [],
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
    byTicker: byTicker.slice(0, 20),
    summary,
  };
}
